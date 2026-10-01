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

for (const scenario of ["reconnect", "stop"] as const) {
  test(`bounded ${scenario} waiting releases input without inventing a remote outcome`, async t => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-wait-"));
    const previous = process.env.PI_CLOUD_CLIENT_STATE;
    process.env.PI_CLOUD_CLIENT_STATE = join(root, "state.json");
    const handlers: Record<string, Function> = {};
    t.after(async () => {
      t.mock.timers.reset();
      if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
      else process.env.PI_CLOUD_CLIENT_STATE = previous;
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    await saveClientState({ locale: "en", activeWorkerId: "worker", connections: [{ workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), token: "fixture", pairedAt: "now" }], tasks: [{ taskId: "task", workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), projectId: root, sessionId: "session", baseLeafId: null, lastEntryId: null, entriesSha256: "empty", cursor: 0, status: "running", prompt: "work", updatedAt: "now", accepted: true }] });
    const notifications: string[] = [];
    const ctx = { cwd: root, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session", getEntries: () => [] },
      ui: { setStatus() {}, setWidget() {}, setEditorText() {}, notify: (text: string) => notifications.push(text) },
    } as unknown as ExtensionCommandContext;
    const fake = { registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {}, appendEntry() {},
      on(name: string, handler: Function) { handlers[name] = handler; },
      registerCommand(name: string, options: { handler: Function }) { handlers[name] = options.handler; },
    } as unknown as ExtensionAPI;
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, { readyState: 1, send() {}, ping() {}, terminate() { emitter.emit("close", 1000); } });
    let attempts = 0;
    t.mock.method(CloudConnection.prototype, "openEvents", async () => {
      attempts++;
      if (scenario === "reconnect") throw new Error("ECONNREFUSED");
      return socket;
    });
    await extension(fake);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await handlers.session_start!({}, ctx);
    assert.deepEqual(await handlers.input!({ text: "still locked" }, ctx), { action: "handled" });
    if (scenario === "stop") {
      await handlers["cloud-abort"]!("", ctx);
      t.mock.timers.tick(30_000);
    } else {
      for (const delay of [1_000, 2_000, 4_000, 8_000, 8_000]) {
        t.mock.timers.tick(delay);
        for (let n = 0; n < 12; n++) await Promise.resolve();
      }
      assert.equal(attempts, 6, "one initial attempt and at most five retries");
    }
    assert.deepEqual(await handlers.input!({ text: "local again" }, ctx), { action: "continue" });
    const task = (await loadClientState()).tasks![0]!;
    assert.equal(task.status, "running");
    assert.equal(task.pendingInputs, undefined);
    assert.ok(notifications.some(text => text.includes("may still be running")));
    await handlers.session_shutdown!({}, ctx);
  });
}
