import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/client.js";
import { CloudConnection } from "../src/client-network.js";
import { saveClientState } from "../src/client-state.js";
import { parseFrame, type ProtocolFrame } from "../src/protocol.js";

test("remote dialog closure dismisses local confirmation without sending a late answer", async t => {
  const root = await mkdtemp(join(tmpdir(), "cloud-dialog-"));
  const previous = process.env.PI_CLOUD_CLIENT_STATE;
  process.env.PI_CLOUD_CLIENT_STATE = join(root, "state.json");
  const handlers: Record<string, Function> = {};
  const sent: string[] = [];
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, { readyState: 1, send: (frame: string) => sent.push(frame), ping() {}, terminate() {} });
  let receive: (frame: ProtocolFrame) => void = () => assert.fail("transport was not connected");
  t.mock.method(CloudConnection.prototype, "openEvents", async (callback: typeof receive) => { receive = callback; return socket; });
  let dialogSignal: AbortSignal | undefined;
  const ctx = { cwd: root, mode: "rpc", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "session", getEntries: () => [] },
    ui: { setStatus() {}, setWidget() {}, setEditorText() {}, notify() {}, confirm: async (_title: string, _message: string, options: { signal: AbortSignal }) => {
      dialogSignal = options.signal;
      return new Promise<boolean>(resolve => options.signal.addEventListener("abort", () => resolve(false), { once: true }));
    } },
  } as unknown as ExtensionCommandContext;
  t.after(async () => {
    await handlers.session_shutdown?.({}, ctx);
    if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE; else process.env.PI_CLOUD_CLIENT_STATE = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await saveClientState({ locale: "en", activeWorkerId: "worker", connections: [{ workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), token: "fixture", pairedAt: "now" }], tasks: [{ taskId: "task", workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), projectId: root, sessionId: "session", baseLeafId: null, lastEntryId: null, entriesSha256: "empty", cursor: 0, status: "running", prompt: "work", updatedAt: "now", accepted: true }] });
  await extension({ registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {}, appendEntry() {}, on(name: string, handler: Function) { handlers[name] = handler; }, registerCommand() {} } as unknown as ExtensionAPI);
  await handlers.session_start!({}, ctx);
  const emit = (cursor: number, rpc: object) => receive(parseFrame(JSON.stringify({ type: "task_event", event: { taskId: "task", cursor, kind: "tool", payload: { rpc } } })));
  emit(1, { type: "extension_ui_request", id: "dialog", method: "confirm", title: "Remote approval", message: "Allow?" });
  for (let i = 0; i < 100 && !dialogSignal; i++) await delay(5);
  assert.ok(dialogSignal);
  emit(2, { type: "extension_ui_closed", id: "dialog" });
  await delay(20);
  assert.equal(dialogSignal.aborted, true);
  assert.ok(sent.every(frame => JSON.parse(frame).type !== "task_ui_response"));
});
