import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn } from "@lydell/node-pty";
import { saveClientState } from "../src/client-state.js";
import { CloudConnection } from "../src/client-network.js";
import { createPairing } from "../src/worker/pairing.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";
import { startWorkerServer } from "../src/worker/server.js";
import type { TaskSpec } from "../src/protocol.js";

// Real Pi's interactive mode through POSIX PTY / Windows ConPTY, not RPC or a mock editor.
for (const mode of ["regular", "fullscreen"] as const) {
for (const outcome of ["completed", "abort"] as const) {
test(`real terminal (${mode}, ${outcome}) streams output, routes literal append and releases the editor`,  { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-terminal-"));
  for (const args of [["init", "-q"], ["config", "user.name", "Terminal fixture"], ["config", "user.email", "test@example.com"]]) await promisify(execFile)("git", args, { cwd: root });
  await writeFile(join(root, ".gitignore"), "agent/\nworker/\nsession.jsonl\n");
  await promisify(execFile)("git", ["add", ".gitignore"], { cwd: root });
  await promisify(execFile)("git", ["commit", "-qm", "fixture"], { cwd: root });
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const worker = await startWorkerServer({ dataDir: join(root, "worker"), publicIp: "127.0.0.1", port: 0, piVersion: "0.85.1", nodeVersion: process.version, gitVersion: "git", enableExecution: false });
  const state = await loadWorkerState(join(root, "worker"));
  const pairing = createPairing(state);
  await saveWorkerState(join(root, "worker"), state);
  const connection = new CloudConnection(worker.url, state.certificateFingerprint!);
  const paired = await connection.pair(pairing.code);
  const sessionId = randomUUID();
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const task: TaskSpec = { taskId: "terminal-task", projectId: root, prompt: "Terminal fixture", runner: "host", environment: { piVersion: "0.85.1", nodeVersion: "24", platform: process.platform, packages: [], resources: [], providers: [], secretVersions: [], warnings: [] }, git: { repositoryHash: "repo", head: "head", indexHash: "index", worktreeHash: "tree", includedPaths: [] }, session: { sessionId, baseLeafId: null, lastEntryId: null, entriesSha256: "empty" }, artifacts: [], secretIds: [] };
  worker.tasks.create(task);
  await saveClientState({ locale: "en", activeWorkerId: paired.workerId, connections: [{ ...paired, baseUrl: worker.url, fingerprint: state.certificateFingerprint!, pairedAt: new Date().toISOString() }], tasks: [{ ...task.session, taskId: task.taskId, workerId: paired.workerId, baseUrl: worker.url, fingerprint: state.certificateFingerprint!, projectId: root, cursor: 0, status: "queued", prompt: task.prompt, updatedAt: new Date().toISOString(), accepted: true }] }, join(agentDir, "pi-cloud.json"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], theme: mode === "regular" ? "dark" : "light", defaultProvider: "fixture", defaultModel: "stub", defaultProjectTrust: "always", quietStartup: true, disableInstallTelemetry: true, analytics: { enabled: false } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "stub" }] } } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all)$/i.test(key))) as Record<string, string>;
  const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const terminal = spawn(process.execPath, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", fileURLToPath(new URL("../../src/client.ts", import.meta.url)), "--session", sessionFile, "--tui-mode", mode], { cwd: root, cols: 100, rows: 30, name: "xterm-256color", env: { ...env, TERM: "xterm-256color", PI_CODING_AGENT_DIR: agentDir, PI_CLOUD_CLIENT_STATE: join(agentDir, "pi-cloud.json") } });
  let output = "";
  let exited = false;
  terminal.onData(data => { output += data; });
  const exit = new Promise<void>(resolve => terminal.onExit(() => { exited = true; resolve(); }));
  const until = async (predicate: () => boolean, budgetMs = 10_000) => {
    for (let n = 0; n < budgetMs / 50; n++) { if (predicate()) return; if (exited) break; await delay(50); }
    assert.fail(`Terminal did not reach expected state:\n${output.slice(-12000)}`);
  };
  try {
    // Cold Pi/JIT startup competes with native Worker tests; UI action waits remain 10s.
    await until(() => output.includes("Esc stop"), 30_000);
    worker.tasks.log(task.taskId, { rpc: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "LIVE_DELTA_中文" } } });
    await until(() => output.includes("LIVE_DELTA_中文"));
    worker.tasks.log(task.taskId, { rpc: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "REMOTE_FINAL_TRANSCRIPT" }] } } });
    await until(() => output.includes("REMOTE_FINAL_TRANSCRIPT"));
    worker.tasks.log(task.taskId, { rpc: { type: "tool_execution_end", toolName: "fixture", isError: true, result: { content: [{ type: "text", text: "REMOTE_TOOL_FAILURE" }] } } });
    await until(() => output.includes("REMOTE_TOOL_FAILURE"));
    terminal.write("MUST_NOT_SEND\r");
    await delay(300);
    assert.equal(worker.tasks.exportState()[0]!.inputs.length, 0);
    terminal.resize(45, 20);
    terminal.resize(100, 30);
    terminal.write("\x1b[17~"); // F6 (xterm / Windows Terminal).
    await until(() => output.includes("Append instruction"));
    terminal.write("\r");
    await until(() => output.includes("Append mode"));
    terminal.write("\x1b[200~/cloud-abort 中文 literal\x1b[201~");
    await delay(150);
    terminal.write("\r");
    await until(() => worker.tasks.exportState()[0]!.inputs.length === 1);
    assert.equal(worker.tasks.exportState()[0]!.inputs[0]!.message, "/cloud-abort 中文 literal");
    assert.ok(["queued", "running"].includes(worker.tasks.exportState()[0]!.status), "literal slash input must not abort the task through a local cloud command");
    if (outcome === "abort") {
      terminal.write("\x1b");
      await until(() => worker.tasks.get(task.taskId)?.status === "aborted");
    } else worker.tasks.settle(task.taskId, "completed");
    await until(() => output.includes("input area is released"));
    terminal.write("LOCAL_DRAFT");
    await until(() => output.includes("LOCAL_DRAFT"));
    terminal.write("\x1b[17~");
    await until(() => output.includes("Git workspace"));
    terminal.write("\x1b");
    await delay(300);
    assert.equal(worker.tasks.exportState().length, 1, "cancelled F6 preflight must not create another task");
  } finally {
    terminal.kill();
    await Promise.race([exit, delay(3000)]);
    await worker.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
}
}
