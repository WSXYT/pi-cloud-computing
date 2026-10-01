import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/client.js";
import { CloudConnection } from "../src/client-network.js";
import { loadClientState, saveClientState } from "../src/client-state.js";
import type { ProtocolFrame, TaskSpec } from "../src/protocol.js";

for (const code of ["TASK_NOT_FOUND", "WORKER_STORAGE_ERROR", "INVALID_FRAME"] as const) {
  test(`${code} on reconnect releases local input without silently creating another task`, async t => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-unknown-"));
    const previous = process.env.PI_CLOUD_CLIENT_STATE;
    process.env.PI_CLOUD_CLIENT_STATE = join(root, "state.json");
    const handlers: Record<string, Function> = {};
    const ctx = { cwd: root, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session", getEntries: () => [] },
      ui: { setStatus() {}, setWidget() {}, setEditorText() {}, notify() {}, confirm: async () => false },
    } as unknown as ExtensionCommandContext;
    t.after(async () => {
      await handlers.session_shutdown?.({}, ctx);
      if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
      else process.env.PI_CLOUD_CLIENT_STATE = previous;
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    const task: TaskSpec = { taskId: "original", projectId: root, prompt: "must not run twice", runner: "host",
      environment: { piVersion: "test", nodeVersion: "24", platform: "test", packages: [], resources: [], providers: [], secretVersions: [], warnings: [] },
      git: { repositoryHash: "repo", head: "head", indexHash: "index", worktreeHash: "tree", includedPaths: [] },
      session: { sessionId: "session", baseLeafId: null, lastEntryId: null, entriesSha256: "empty" }, artifacts: [], secretIds: [] };
    await saveClientState({ locale: "en", activeWorkerId: "worker", connections: [{ workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), token: "fixture", pairedAt: "now" }], tasks: [{ ...task.session, taskId: task.taskId, projectId: root, workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), prompt: task.prompt, status: "queued", cursor: 0, updatedAt: "now", accepted: false, readyToSubmit: true, spec: task }] });
    const sent: ProtocolFrame[] = [];
    const visible: unknown[] = [];
    let onFrame: (frame: ProtocolFrame) => void = () => {};
    t.mock.method(CloudConnection.prototype, "openEvents", async (receive: typeof onFrame) => {
      onFrame = receive;
      const socket = new EventEmitter();
      return Object.assign(socket, { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)), ping() {}, terminate: () => socket.emit("close", 1000) });
    });
    await extension({ registerEntryRenderer() {}, registerMessageRenderer() {}, appendEntry() {},
      sendMessage(message: unknown, options: { triggerTurn: boolean }) { assert.equal(options.triggerTurn, false); visible.push(message); },
      sendUserMessage() { assert.fail("a transport error must not trigger a local turn or command"); },
      on(name: string, handler: Function) { handlers[name] = handler; },
      registerCommand(name: string, options: { handler: Function }) { handlers[name] = options.handler; },
    } as unknown as ExtensionAPI);
    const hello = { type: "hello_ack", worker: { workerId: "worker" } } as ProtocolFrame;
    const failure: ProtocolFrame = { type: "error", ...(code !== "INVALID_FRAME" ? { requestType: "task_resume" as const } : {}), error: { code, retryable: false, params: { cause: "ENOSPC" } } };
    await handlers.session_start!({}, ctx);
    onFrame(hello); onFrame(failure);
    assert.deepEqual(await handlers.input!({ text: "continue locally" }, ctx), { action: "continue" });
    await handlers["cloud-reconnect"]!("", ctx); onFrame(hello); onFrame(failure);
    await handlers["cloud-retry"]!("", ctx); // Explicit retry declined: still no new work.
    await handlers.session_shutdown!({}, ctx);
    assert.equal(sent.filter(frame => frame.type === "task_resume").length, 2);
    assert.equal(sent.some(frame => frame.type === "task_create"), false);
    assert.equal(visible.length, 2, "both failures are visible in the transcript, not only task history");
    const saved = (await loadClientState()).tasks!;
    assert.equal(saved.length, 1); assert.equal(saved[0]!.taskId, "original");
    assert.equal(saved[0]!.status, "queued", "absence of an acknowledgement cannot establish a remote outcome");
    assert.equal(saved[0]!.outcomeUnknown, true);
  });
}
