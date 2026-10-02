import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { CloudComponentClient } from "../src/client-components.js";
import { SdkComponentHost } from "../src/worker/sdk-components.js";
import { parseComponentFrame, parseComponentInput, type ComponentFrame } from "../src/component-protocol.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail("component UI did not reach the expected state");
}

test("client hosts a scoped native input component, preserves cloud callback values and ignores late frames", async () => {
  let local: Component | undefined, opens = 0, stops = 0, rendered = "";
  const frames: ComponentFrame[] = [];
  const tui = { terminal: { rows: 24 }, requestRender() { rendered = local?.render(80).join("\n") ?? ""; } } as TUI;
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const ui = {
    custom: async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> => new Promise<T>((resolve, reject) => {
      opens++;
      void Promise.resolve(factory(tui, theme, {} as KeybindingsManager, value => resolve(value as T))).then(component => {
        local = component; tui.requestRender();
      }).catch(reject);
    }),
  } as ExtensionUIContext;
  const host = new SdkComponentHost(frame => {
    frames.push(frame);
    client.receive(parseComponentFrame(JSON.parse(JSON.stringify(frame))));
  }, truncateToWidth);
  const client = new CloudComponentClient(ui, input => host.receive(parseComponentInput(JSON.parse(JSON.stringify(input)))), () => { stops++; host.close(); }, "Cloud plugin", "Waiting");
  try {
    const opaque = new Set(["task closure"]);
    const pending = host.custom(done => {
      const input = new Input();
      input.onSubmit = value => done({ value, opaque });
      return input;
    });
    await until(() => local !== undefined);
    local!.handleInput?.("中文 draft");
    await until(() => rendered.includes("中文 draft"));
    local!.handleInput?.("\r");
    const result = await pending;
    assert.equal((result as { value: string }).value, "中文 draft");
    assert.equal((result as { opaque: Set<string> }).opaque, opaque);
    const lastFrame = frames.findLast(frame => frame.type === "frame")!;
    client.receive(lastFrame);
    await delay(10);
    assert.equal(opens, 1, "a late frame must not reopen a resolved modal");
    local = undefined;
    const stopped = host.custom(() => new Input());
    const rejection = assert.rejects(stopped, /CLOUD_UI_CLOSED/);
    await until(() => local !== undefined);
    local!.handleInput?.("\x03");
    await rejection;
    assert.equal(stops, 1, "Ctrl+C stops the task even while the plugin owns Escape");
  } finally { client.close(); host.close(); }
});
