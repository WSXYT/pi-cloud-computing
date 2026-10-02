import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn } from "@lydell/node-pty";
import { loadClientState, saveClientState } from "../src/client-state.js";
import { CloudConnection } from "../src/client-network.js";
import { createWorkspaceArchive, serializeWorkspaceArchive } from "../src/git.js";
import { scanEnvironment } from "../src/environment-archive.js";
import { sha256 } from "../src/environment.js";
import { createPairing } from "../src/worker/pairing.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";
import { ArtifactStore } from "../src/worker/artifacts.js";
import { startWorkerServer } from "../src/worker/server.js";
import type { TaskSpec } from "../src/protocol.js";

for (const mode of ["regular", "fullscreen"] as const) test(`real ${mode} terminal: SDK stream, Escape, cleanup and local model reply`, { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-execution-pty-"));
  const project = join(root, "project"), agentDir = join(root, "agent"), workerDir = join(root, "worker");
  const requests: string[] = [];
  let remoteClosed = false;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "stub", created: 1, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "actual-failure", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "missing-for-real-error.txt" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const first = requests.length === 2;
    if (first) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "stub", created: 1, choices: [{ index: 0, delta: { reasoning_content: "REAL_MODEL_THINKING" }, finish_reason: null }] })}\n\n`);
    const content = first ? "REMOTE_UNMERGED_STREAM" : "LOCAL_MODEL_REPLY_AFTER_ESCAPE";
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "stub", created: 1, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
    if (first) { response.once("close", () => { remoteClosed = true; }); return; }
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "stub", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const address = provider.address(); assert.ok(address && typeof address !== "string");
  await mkdir(project); await mkdir(agentDir);
  if (mode === "fullscreen") await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.interrupt": "alt+x" }));
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.com"]]) await promisify(execFile)("git", args, { cwd: project });
  await writeFile(join(project, "file.txt"), "unchanged\n");
  await promisify(execFile)("git", ["add", "."], { cwd: project });
  await promisify(execFile)("git", ["commit", "-qm", "fixture"], { cwd: project });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "fixture", defaultModel: "stub", defaultProjectTrust: "always", retry: { enabled: false }, quietStartup: true, disableInstallTelemetry: true, analytics: { enabled: false } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "FAKE_PTY_KEY", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "stub", reasoning: true }] } } }));
  const workspace = await createWorkspaceArchive(project);
  const environment = await scanEnvironment({ cwd: project, agentDir, piVersion: "0.85.1" });
  const worker = await startWorkerServer({ dataDir: workerDir, publicIp: "127.0.0.1", port: 0, piVersion: "0.85.1", nodeVersion: process.version, gitVersion: "git" });
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const state = await loadWorkerState(workerDir), pairing = createPairing(state);
  await saveWorkerState(workerDir, state);
  const paired = await new CloudConnection(worker.url, state.certificateFingerprint!).pair(pairing.code);
  const connection = new CloudConnection(worker.url, state.certificateFingerprint!, paired.token);
  const credentialData = JSON.stringify(environment.credentials), credentialHash = sha256(credentialData), secretId = `pi-runtime-${credentialHash}`;
  const metadata = await connection.uploadSecret(secretId, credentialData);
  environment.archive.manifest.secretVersions = [{ id: secretId, version: metadata.version, sha256: credentialHash, authorized: true }];
  const taskId = randomUUID(), sessionId = randomUUID(), sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: project }) + "\n");
  const payloads = [{ id: "workspace-fixture", kind: "workspace" as const, data: Buffer.from(serializeWorkspaceArchive(workspace)) }, { id: "environment-fixture", kind: "environment" as const, data: Buffer.from(JSON.stringify(environment.archive)) }];
  const artifacts = await ArtifactStore.open(workerDir);
  for (const payload of payloads) await artifacts.put(payload.id, payload.data);
  const task: TaskSpec = { taskId, projectId: project, prompt: "Stream until stopped", model: { provider: "fixture", id: "stub" }, runner: "host", environment: environment.archive.manifest, git: workspace.snapshot.baseline, session: { sessionId, baseLeafId: null, lastEntryId: null, entriesSha256: sha256("") }, artifacts: payloads.map(p => ({ id: p.id, kind: p.kind, size: p.data.length, sha256: sha256(p.data), contentType: "application/json" })), secretIds: [secretId] };
  await saveClientState({ locale: "en", activeWorkerId: paired.workerId, connections: [{ ...paired, baseUrl: worker.url, fingerprint: state.certificateFingerprint!, pairedAt: new Date().toISOString() }], tasks: [{ ...task.session, taskId, workerId: paired.workerId, baseUrl: worker.url, fingerprint: state.certificateFingerprint!, projectId: project, cursor: 0, status: "queued", prompt: task.prompt, updatedAt: new Date().toISOString(), accepted: true }] }, join(agentDir, "pi-cloud.json"));
  worker.tasks.create(task);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all)$/i.test(key))) as Record<string, string>;
  const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const terminal = spawn(process.execPath, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", fileURLToPath(new URL("../../src/client.ts", import.meta.url)), "--session", sessionFile, "--tui-mode", mode], { cwd: project, cols: 100, rows: 30, env: { ...env, TERM: "xterm-256color", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, PI_CLOUD_CLIENT_STATE: join(agentDir, "pi-cloud.json") } });
  let output = ""; terminal.onData(data => { output += data; });
  const exit = new Promise<void>(resolve => terminal.onExit(() => resolve()));
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 600; i++) { if (predicate()) return; await delay(50); } assert.fail(JSON.stringify({ output: output.slice(-4000), status: worker.tasks.get(taskId)?.status, tail: worker.tasks.get(taskId)?.events.slice(-5) })); };
  try {
    await until(() => output.includes("REMOTE_UNMERGED_STREAM"));
    assert.equal(requests.length, 2);
    assert.ok(requests[1]!.includes("missing-for-real-error.txt"));
    await until(() => output.includes("REAL_MODEL_THINKING"));
    assert.ok(worker.tasks.get(taskId)!.events.some(event => { const rpc = event.payload.rpc as { type?: string; isError?: boolean }; return rpc?.type === "tool_execution_end" && rpc.isError === true; }), "a real tool must actually fail, not an injected UI event");
    output = ""; terminal.write("\x14");
    await until(() => output.includes("Thinking..."));
    output = ""; terminal.write("\x14");
    await until(() => output.includes("REAL_MODEL_THINKING"));
    terminal.write("\x0f");
    await until(() => output.includes("Tool output: expanded"));
    terminal.resize(110, 35);
    await until(() => output.includes("missing-for-real-error.txt"));
    terminal.write("UNEXECUTED_FOLLOWUP"); await delay(150);
    terminal.write(process.platform === "win32" ? "\x11" : "\x1b\r");
    await until(() => output.includes("Cloud follow-up: UNEXECUTED_FOLLOWUP"));
    terminal.write("DRAFT_TO_CLEAR"); await delay(150); terminal.write("\x03"); await delay(150);
    assert.equal(worker.tasks.get(taskId)?.status, "running", "native clear must not stop the task");
    terminal.write("KEEP_LOCAL_DRAFT"); await delay(150);
    assert.ok((await readFile(join(workerDir, "tasks", taskId, "runtime", "agent", "models.json"), "utf8")).includes("FAKE_PTY_KEY"));
    terminal.write("\x1b"); // Default Escape stops; rebinding must remove the old stop key.
    if (mode === "fullscreen") {
      await delay(200);
      assert.equal(worker.tasks.get(taskId)?.status, "running", "Escape must not bypass the configured interrupt key");
      terminal.write("\x1bx");
    }
    await until(() => remoteClosed && worker.tasks.get(taskId)?.status === "aborted" && worker.tasks.get(taskId)?.finalizing === false);
    await assert.rejects(readFile(join(workerDir, "tasks", taskId, "runtime", "agent", "models.json")), { code: "ENOENT" });
    await until(() => output.includes("input area is released"));
    await until(() => output.includes("UNEXECUTED_FOLLOWUP") && output.includes("KEEP_LOCAL_DRAFT"));
    assert.equal((await loadClientState(join(agentDir, "pi-cloud.json"))).tasks?.[0]?.dequeuedDraft, "UNEXECUTED_FOLLOWUP", "stop must atomically recover the unexecuted queue without a prior dequeue");
    // Native Pi treats two clears within 500ms as exit; fast Linux task shutdown can fit that window.
    await delay(550);
    terminal.write("\x03"); await delay(150); // Clear the restored draft deliberately before the local turn.
    terminal.write("LOCAL_PROMPT_AFTER_ESCAPE\r");
    await until(() => output.includes("LOCAL_MODEL_REPLY_AFTER_ESCAPE"));
    assert.equal(requests.length, 3);
    assert.ok(requests[2]!.includes("LOCAL_PROMPT_AFTER_ESCAPE"));
    assert.ok(!requests[2]!.includes("UNEXECUTED_FOLLOWUP"), "restoring queued text must not execute it");
    assert.ok(!requests[2]!.includes("REMOTE_UNMERGED_STREAM"), "remote display must not leak into the local model context");
    assert.equal(worker.tasks.exportState().length, 1, "local Enter must not create another cloud task");
    assert.equal(await readFile(join(project, "file.txt"), "utf8"), "unchanged\n");
    assert.ok(!output.includes("FAKE_PTY_KEY"));
  } finally { terminal.kill(); await Promise.race([exit, delay(3000)]); }
});
