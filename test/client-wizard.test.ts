import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import extension from "../src/client.js";
import { selectCloudMenu } from "../src/client-menu.js";
import { CloudConnection } from "../src/client-network.js";
import { loadClientState, saveClientState } from "../src/client-state.js";
import { translate } from "../src/i18n.js";

for (const locale of ["en", "zh-CN"] as const) {
  test(`single cloud entry guides installation and cancels every pairing step without network (${locale})`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-wizard-"));
    const path = join(root, "state.json");
    const previous = process.env.PI_CLOUD_CLIENT_STATE;
    process.env.PI_CLOUD_CLIENT_STATE = path;
    t.after(async () => {
      if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
      else process.env.PI_CLOUD_CLIENT_STATE = previous;
      await rm(root, { recursive: true, force: true });
    });
    await saveClientState({ locale, connections: [] }, path);
    const tr = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const fake = {
      registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, options.handler); },
      registerEntryRenderer() {}, on() {},
    } as unknown as ExtensionAPI;
    const pair = t.mock.method(CloudConnection.prototype, "pair", async () => { throw new Error("unexpected network request"); });
    const screens: Array<{ title: string; choices: string[] }> = [];
    const errors: string[] = [];
    let choices: Array<string | undefined> = [tr("cloud.installChoice"), tr("cloud.back"), undefined];
    let inputs: Array<string | undefined> = [];
    let inputCount = 0;
    const ctx = {
      cwd: root, mode: "rpc", hasUI: true,
      ui: {
        async select(title: string, options: string[]) {
          screens.push({ title, choices: options });
          const choice = choices.shift();
          if (choice !== undefined) assert.ok(options.includes(choice), `${title}: ${choice}`);
          return choice;
        },
        async input() { inputCount++; return inputs.shift(); },
        notify(message: string, level: string) { if (level === "error") errors.push(message); },
      },
    } as unknown as ExtensionCommandContext;
    await extension(fake);
    const cloud = commands.get("cloud")!;
    await cloud("", ctx);
    assert.ok(screens[0]?.title.includes(tr("cloud.welcomeBody")));
    assert.ok(screens.some((screen) => screen.title.includes(`--worker --lang ${locale}`)));
    assert.equal(screens[0]?.choices.length, 3, "first use should not expose the entire command catalog");
    for (const fields of [[undefined], ["", undefined], ["", "https://worker.invalid", undefined], ["", "https://worker.invalid", "ab".repeat(32), undefined]]) {
      choices = [tr("cloud.installedChoice"), undefined];
      inputs = [...fields];
      inputCount = 0;
      await cloud("", ctx);
      assert.equal(inputCount, fields.length, "cancel must not ask for subsequent fields");
    }
    assert.equal(pair.mock.callCount(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual((await loadClientState(path)).connections, []);
  });
}

test("cloud TUI renders context at narrow widths and supports selection and Escape", async () => {
  for (const key of ["\r", "\u001b"]) {
    let screen = "";
    const ctx = {
      mode: "tui", hasUI: true,
      ui: { custom<T>(factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string; bold(text: string): string }, keybindings: unknown, done: (value: T) => void) => { render(width: number): string[]; handleInput?(data: string): void }): Promise<T> {
        return new Promise((resolve) => {
          const component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, resolve);
          for (const width of [30, 60, 100]) {
            const lines = component.render(width);
            for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeded ${width}: ${line}`);
            screen += lines.join("\n");
          }
          component.handleInput?.(key);
        });
      } },
    } as unknown as ExtensionCommandContext;
    const result = await selectCloudMenu(ctx, "Pi Cloud · 首次使用", ["Local project: /workspace/project", "Nothing uploaded yet"], [
      { value: "start", label: "开始 / Start", description: "Create an independent remote copy" },
      { value: "back", label: "返回 / Back" },
    ], "Enter · Esc");
    assert.equal(result, key === "\r" ? "start" : null);
    assert.match(screen, /Nothing uploaded yet/);
  }
});
