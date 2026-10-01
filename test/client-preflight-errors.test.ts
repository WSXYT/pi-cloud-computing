import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/client.js";
import { CloudConnection, CloudRequestError } from "../src/client-network.js";
import { formatCloudError } from "../src/client-errors.js";
import { loadClientState, saveClientState } from "../src/client-state.js";

for (const failure of ["legacy", "storage"] as const) {
  test(`${failure} Worker is rejected before scanning/uploading and the F6 draft survives`, async t => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-preflight-failure-"));
    const previous = process.env.PI_CLOUD_CLIENT_STATE;
    process.env.PI_CLOUD_CLIENT_STATE = join(root, "state.json");
    t.after(async () => {
      if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
      else process.env.PI_CLOUD_CLIENT_STATE = previous;
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    await saveClientState({ locale: "en", activeWorkerId: "worker", connections: [{ workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), token: "fixture", pairedAt: "now" }] });
    const session = join(root, "session.jsonl"); await writeFile(session, "fixture");
    const commands: Record<string, Function> = {};
    await extension({ registerEntryRenderer() {}, registerMessageRenderer() {}, on() {},
      registerCommand(name: string, options: { handler: Function }) { commands[name] = options.handler; },
      sendUserMessage() { assert.fail("must not resubmit"); }, sendMessage() {},
    } as unknown as ExtensionAPI);
    t.mock.method(CloudConnection.prototype, "workerInfo", async () => ({ workerId: "worker", capabilities: { runtimeArchiveVersion: 1, ...(failure === "storage" ? { cloudVersion: "0.2.1", storageHealthy: false, storageError: "ENOSPC" } : {}) } }));
    const upload = t.mock.method(CloudConnection.prototype, "upload", async () => assert.fail("no upload before compatibility/health checks"));
    let draft = ""; const notices: string[] = [];
    const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionFile: () => session },
      ui: { getEditorText: () => draft, setEditorText: (text: string) => { draft = text; }, setStatus() {}, setWidget() {}, notify: (text: string) => notices.push(text) },
    } as unknown as ExtensionCommandContext;
    await commands["cloud-submit"]!("preserve this draft", ctx);
    assert.equal(draft, "preserve this draft");
    assert.equal(upload.mock.callCount(), 0);
    assert.equal((await loadClientState()).tasks?.length ?? 0, 0);
    assert.match(notices.join("\n"), failure === "legacy" ? /Updating the local plugin does not update the server/ : /ENOSPC/);
  });
}

test("a failed upload reports phase, size and disk cause in both languages", () => {
  const error = new CloudRequestError("WORKER_STORAGE_ERROR", { phase: "response", operation: "artifact_upload", totalBytes: 6_061_485, sentBytes: 6_061_485, receivedBytes: 80, elapsedMs: 30_000 }, "ENOSPC");
  for (const locale of ["en", "zh-CN"] as const) {
    const text = formatCloudError(error, locale);
    assert.match(text, /ENOSPC/); assert.match(text, /30/);
    assert.match(text, locale === "en" ? /waiting for server response/ : /等待服务器响应/);
    assert.match(text, locale === "en" ? /not a server acknowledgement/ : /不等于服务器已确认/);
  }
});
