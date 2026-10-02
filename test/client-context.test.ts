import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertToLlm, type ContextEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/client.js";

test("cloud display cards never become user input on subsequent local turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-context-"));
  const previous = process.env.PI_CLOUD_CLIENT_STATE;
  process.env.PI_CLOUD_CLIENT_STATE = join(root, "state.json");
  try {
    let filter: ((event: ContextEvent) => { messages: ContextEvent["messages"] }) | undefined;
    await extension({
      registerCommand() {}, registerShortcut() {}, registerEntryRenderer() {}, registerMessageRenderer() {},
      on(name: string, handler: typeof filter) { if (name === "context") filter = handler; },
    } as unknown as ExtensionAPI);
    assert.ok(filter);
    const messages: ContextEvent["messages"] = [
      { role: "user", content: "LOCAL_PROMPT", timestamp: 1 },
      ...["pi-cloud-live", "pi-cloud-native", "pi-cloud-task", "unrelated-plugin"].map(customType => ({
        role: "custom" as const, customType, content: `DISPLAY_${customType}`, display: true, timestamp: 2,
      })),
    ];
    assert.ok(JSON.stringify(convertToLlm(messages)).includes("DISPLAY_pi-cloud-live"), "prove triggerTurn:false alone does not isolate context");
    const result = filter({ type: "context", messages });
    const payload = JSON.stringify(convertToLlm(result.messages));
    assert.ok(payload.includes("LOCAL_PROMPT"));
    assert.ok(payload.includes("DISPLAY_unrelated-plugin"));
    assert.ok(!payload.includes("DISPLAY_pi-cloud-"));
    assert.equal(messages.length, 5, "filtering must not delete the visible session history");
  } finally {
    if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
    else process.env.PI_CLOUD_CLIENT_STATE = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
