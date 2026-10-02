import assert from "node:assert/strict";
import test from "node:test";
import { type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { CloudEditor, type CloudEditorState } from "../src/client-editor.js";

test("cloud editor locks preparation only and keeps running drafts editable with stop and literal input", () => {
  const state: CloudEditorState = { locked: true, append: false, status: "F6 · remote task running" };
  let shortcuts = 0;
  let cancelled = 0;
  let stopped = 0;
  const literal: string[] = [];
  const native: string[] = [];
  let interrupt = "\u001b";
  const editor = new CloudEditor(
    { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI,
    { borderColor: (text: string) => text } as EditorTheme,
    { matches: (data: string, action: string) => (action === "tui.input.submit" && data === "\r") || (action === "app.interrupt" && data === interrupt) || (action === "app.clear" && data === "\u0003") } as unknown as KeybindingsManager,
    () => state, (text) => text, () => { cancelled++; state.append = false; }, (text) => literal.push(text), () => { stopped++; },
  );
  editor.onExtensionShortcut = (key) => { if (key !== "f6") return false; shortcuts++; return true; };
  editor.onSubmit = (text) => native.push(text);
  editor.onAction("app.clear", () => editor.setText(""));
  editor.handleInput("ordinary input");
  assert.equal(editor.getText(), "");
  editor.handleInput("f6");
  assert.equal(shortcuts, 1);
  assert.equal(visibleWidth(editor.render(30)[0]!), 30);
  editor.handleInput("\u001b");
  editor.handleInput("\u0003");
  assert.equal(stopped, 1, "only the configured interrupt stops cloud work");
  state.locked = false; state.busy = true;
  editor.handleInput("\u001b");
  assert.equal(stopped, 2, "stop still works when the cloud shortcut is disabled");
  state.busy = false;
  editor.handleInput("local");
  assert.equal(editor.getText(), "local");
  state.locked = false; state.busy = true;
  editor.setText("");
  editor.handleInput("running draft");
  assert.equal(editor.getText(), "running draft");
  state.append = true;
  editor.setText("/cloud status");
  editor.handleInput("\r");
  assert.deepEqual(literal, ["/cloud status"]);
  assert.deepEqual(native, []);
  assert.equal(editor.getText(), "");
  editor.setText("draft");
  editor.handleInput("\u001b");
  assert.equal(cancelled, 0);
  assert.equal(stopped, 3);
  assert.equal(editor.getText(), "draft");
  editor.handleInput("\u0003");
  assert.equal(editor.getText(), "", "native Ctrl+C clears the draft, not the remote task");
  assert.equal(stopped, 3);
  interrupt = "\u0018";
  editor.handleInput("\u001b");
  assert.equal(stopped, 3, "old interrupt binding must no longer stop");
  editor.handleInput(interrupt);
  assert.equal(stopped, 4, "custom interrupt binding stops the remote task");
});
