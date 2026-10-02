import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn } from "@lydell/node-pty";
import { saveClientState } from "../src/client-state.js";
import { CloudConnection } from "../src/client-network.js";
import { createWorkspaceArchive, serializeWorkspaceArchive } from "../src/git.js";
import { scanEnvironment } from "../src/environment-archive.js";
import { sha256 } from "../src/environment.js";
import { createPairing } from "../src/worker/pairing.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";
import { ArtifactStore } from "../src/worker/artifacts.js";
import { startWorkerServer } from "../src/worker/server.js";
import type { TaskSpec } from "../src/protocol.js";

for (const mode of ["regular", "fullscreen"] as const) for (const outcome of ["approve", "stop"] as const) test(`real SDK plugin over authenticated Worker and ${mode} terminal: ${outcome}`,  { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-plugin-pty-"));
  const project = join(root, "project"), agentDir = join(root, "agent"), workerDir = join(root, "worker");
  await mkdir(project); await mkdir(join(agentDir, "extensions"), { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "test@example.com"]]) await promisify(execFile)("git", args, { cwd: project });
  await writeFile(join(project, "file.txt"), "before\n");
  await promisify(execFile)("git", ["add", "."], { cwd: project });
  await promisify(execFile)("git", ["commit", "-qm", "fixture"], { cwd: project });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "always", quietStartup: true, disableInstallTelemetry: true, analytics: { enabled: false } }));
  await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.message.dequeue": "alt+u" }));
  await writeFile(join(agentDir, "extensions", "fixture.ts"), `
    import { Input } from '@earendil-works/pi-tui';
    import { writeFile, access } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { join } from 'node:path';
    export default function(pi) { pi.registerCommand('plugin-fixture', { handler: async (_args, ctx) => {
      const closure = new Set(['private-result']);
      const result = await ctx.ui.custom((_tui, _theme, _keys, done) => {
        const input = new Input(); input.focused = true;
        input.onSubmit = text => done({ text, closure });
        return { render: width => ['PLUGIN_CUSTOM_INPUT', ...input.render(width)], handleInput: data => input.handleInput(data), invalidate: () => input.invalidate() };
      });
      if (result.closure !== closure || result.text !== '中文 plugin draft') throw new Error('closure or input lost');
      const approved = await ctx.ui.confirm('PLUGIN_CONFIRM', 'Approve the fixture result?');
      await writeFile(join(ctx.cwd, 'plugin-result.txt'), approved ? 'approved' : 'denied');
      while (true) { try { await access(join(ctx.cwd, 'finish-gate')); break; } catch { await delay(50); } }
    } }); }
  `);
  const workspace = await createWorkspaceArchive(project);
  const environment = await scanEnvironment({ cwd: project, agentDir, piVersion: "0.85.1", nodeVersion: process.version, platform: process.platform });
  const worker = await startWorkerServer({ dataDir: workerDir, publicIp: "127.0.0.1", port: 0, piVersion: "0.85.1", nodeVersion: process.version, gitVersion: "git" });
  const state = await loadWorkerState(workerDir), pairing = createPairing(state);
  await saveWorkerState(workerDir, state);
  const connection = new CloudConnection(worker.url, state.certificateFingerprint!);
  const paired = await connection.pair(pairing.code);
  const sessionId = randomUUID(), taskId = randomUUID(), sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: project }) + "\n");
  const payloads = [{ id: "workspace-fixture", kind: "workspace" as const, data: Buffer.from(serializeWorkspaceArchive(workspace)) }, { id: "environment-fixture", kind: "environment" as const, data: Buffer.from(JSON.stringify(environment.archive)) }];
  const artifacts = await ArtifactStore.open(workerDir);
  for (const payload of payloads) await artifacts.put(payload.id, payload.data);
  const task: TaskSpec = { taskId, projectId: project, prompt: "/plugin-fixture", runner: "host", environment: environment.archive.manifest, git: workspace.snapshot.baseline, session: { sessionId, baseLeafId: null, lastEntryId: null, entriesSha256: sha256("") }, artifacts: payloads.map(p => ({ id: p.id, kind: p.kind, size: p.data.length, sha256: sha256(p.data), contentType: "application/json" })), secretIds: [] };
  await saveClientState({ locale: "en", activeWorkerId: paired.workerId, connections: [{ ...paired, baseUrl: worker.url, fingerprint: state.certificateFingerprint!, pairedAt: new Date().toISOString() }], tasks: [{ ...task.session, taskId, workerId: paired.workerId, baseUrl: worker.url, fingerprint: state.certificateFingerprint!, projectId: project, cursor: 0, status: "queued", prompt: task.prompt, updatedAt: new Date().toISOString(), accepted: true }] }, join(agentDir, "pi-cloud.json"));
  worker.tasks.create(task);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all)$/i.test(key))) as Record<string, string>;
  const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const terminal = spawn(process.execPath, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", fileURLToPath(new URL("../../src/client.ts", import.meta.url)), "--session", sessionFile, "--tui-mode", mode], { cwd: project, cols: 100, rows: 30, env: { ...env, TERM: "xterm-256color", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, PI_CLOUD_CLIENT_STATE: join(agentDir, "pi-cloud.json") } });
  let output = ""; terminal.onData(data => { output += data; });
  const exit = new Promise<void>(resolve => terminal.onExit(() => resolve()));
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 600; i++) { if (predicate()) return; await delay(50); } assert.fail(JSON.stringify({ output: output.slice(-8000), result: worker.tasks.get(taskId)?.result })); };
  try {
    await until(() => output.includes("PLUGIN_CUSTOM_INPUT"));
    terminal.resize(55, 22);
    terminal.write("\x1b[200~中文 plugin draft\x1b[201~");
    await until(() => output.includes("plugin draft"));
    if (outcome === "stop") {
      terminal.write("\x03"); // Component owns Escape; Ctrl+C stops the actual SDK process.
      await until(() => worker.tasks.get(taskId)?.status === "aborted" && worker.tasks.get(taskId)?.finalizing === false);
      await assert.rejects(readFile(join(workerDir, "tasks", taskId, "workspace", "plugin-result.txt")), { code: "ENOENT" });
    } else {
      terminal.write("\r");
      await until(() => output.includes("PLUGIN_CONFIRM"));
      terminal.write("\r"); // Pi's native confirm selects the focused Yes option.
      await until(() => worker.tasks.get(taskId)!.events.some(event => (event.payload.rpc as { type?: string } | undefined)?.type === "extension_ui_closed"));
      terminal.write("QUEUED_PLUGIN_FOLLOWUP");
      await delay(100); terminal.write(process.platform === "win32" ? "\x11" : "\x1b\r");
      await until(() => output.includes("Cloud follow-up: QUEUED_PLUGIN_FOLLOWUP"));
      output = "";
      terminal.write("\x1bu"); // Configured native dequeue action.
      await until(() => worker.tasks.get(taskId)!.events.some(event => (event.payload.rpc as { type?: string } | undefined)?.type === "cloud_queue_restored"));
      await until(() => output.includes("QUEUED_PLUGIN_FOLLOWUP"));
      terminal.write("\x15"); // Keep the restored draft local; never automatically re-submit it.
      await writeFile(join(workerDir, "tasks", taskId, "workspace", "finish-gate"), "finish");
      await until(() => worker.tasks.get(taskId)?.status === "completed");
      assert.equal(await readFile(join(workerDir, "tasks", taskId, "workspace", "plugin-result.txt"), "utf8"), "approved");
    }
    await assert.rejects(readFile(join(workerDir, "tasks", taskId, "runtime", "package.json")), { code: "ENOENT" });
    assert.equal(worker.tasks.get(taskId)!.inputs.length, outcome === "approve" ? 1 : 0, "only the explicit post-modal follow-up belongs in the input queue");
    if (outcome === "approve") assert.equal(worker.tasks.get(taskId)!.inputs[0]!.message, "QUEUED_PLUGIN_FOLLOWUP");
    await until(() => output.includes("input area is released"));
    terminal.write("LOCAL_AFTER_PLUGIN");
    await until(() => output.includes("LOCAL_AFTER_PLUGIN"));
  } finally {
    terminal.kill(); await Promise.race([exit, delay(3000)]);
    await worker.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
