import assert from "node:assert/strict";
import test from "node:test";
import { type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { CloudEditor, type CloudEditorState } from "../src/client-editor.js";

test("cloud editor locks ordinary input, keeps shortcuts and sends slash-prefixed append literally", () => {
  const state: CloudEditorState = { locked: true, append: false, status: "F6 · remote task running" };
  let shortcuts = 0;
  let cancelled = 0;
  const literal: string[] = [];
  const native: string[] = [];
  const editor = new CloudEditor(
    { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI,
    { borderColor: (text: string) => text } as EditorTheme,
    { matches: () => false } as unknown as KeybindingsManager,
    () => state, (text) => text, () => { cancelled++; state.append = false; }, (text) => literal.push(text),
  );
  editor.onExtensionShortcut = (key) => { if (key !== "f6") return false; shortcuts++; return true; };
  editor.onSubmit = (text) => native.push(text);
  editor.handleInput("ordinary input");
  assert.equal(editor.getText(), "");
  editor.handleInput("f6");
  assert.equal(shortcuts, 1);
  assert.equal(visibleWidth(editor.render(30)[0]!), 30);

  state.append = true;
  editor.setText("/cloud status");
  editor.handleInput("\r");
  assert.deepEqual(literal, ["/cloud status"]);
  assert.deepEqual(native, []);
  assert.equal(editor.getText(), "");
  editor.setText("draft");
  editor.handleInput("\u001b");
  assert.equal(cancelled, 1);
  assert.equal(editor.getText(), "draft");
});
