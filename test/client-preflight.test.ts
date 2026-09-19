import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { selectSyncItems } from "../src/client-preflight.js";

interface TestComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
}

interface TestTheme {
  fg(_color: string, text: string): string;
  bold(text: string): string;
}

test("preflight supports toggling multiple items and an explicit upload action", async () => {
  let rendered = "";
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom<T>(
        factory: (
          tui: { requestRender(): void },
          theme: TestTheme,
          keybindings: unknown,
          done: (value: T) => void,
        ) => TestComponent,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          const component = factory(
            { requestRender() {} },
            { fg: (_color, text) => text, bold: (text) => text },
            {},
            resolve,
          );
          for (const width of [30, 80]) {
            const lines = component.render(width);
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
          }
          rendered = component.render(80).join("\n");
          component.handleInput?.(" ");
          component.handleInput?.("\u001b[B");
          component.handleInput?.(" ");
          component.handleInput?.("\u001b[B");
          component.handleInput?.(" ");
          component.handleInput?.("\u001b[B");
          component.handleInput?.("\r");
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  const selected = await selectSyncItems(
    ctx,
    [
      {
        id: "environment",
        label: "Environment",
        description: "18 resources",
        selected: true,
      },
      {
        id: "git",
        label: "Git",
        description: "required",
        selected: true,
        required: true,
      },
      {
        id: "session",
        label: "Session",
        description: "986 entries",
        selected: true,
      },
    ],
    {
      title: "Choose sync content",
      summary: ["Local project: /work/project", "Independent copy; nothing uploaded yet"],
      required: "required",
      upload: "Upload selected",
      cancel: "Cancel",
      help: "Help",
      empty: "Empty",
    },
  );

  assert.deepEqual([...(selected ?? [])], ["git"]);
  assert.match(rendered, /Upload selected/);
  assert.match(rendered, /Cancel/);
  assert.match(rendered, /Local project: \/work\/project/);
  assert.match(rendered, /nothing uploaded yet/);
});
