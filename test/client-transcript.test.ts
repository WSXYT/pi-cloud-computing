import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { CloudTranscript, retainTranscriptEvent } from "../src/client-transcript.js";
import type { TaskEvent } from "../src/protocol.js";

initTheme("dark");
const tui = { requestRender() {} } as TUI;
const event = (cursor: number, rpc: Record<string, unknown>): TaskEvent => ({ taskId: "task", cursor, kind: "log", payload: { rpc } });
const message = (text: string) => ({ role: "assistant", content: [
  { type: "thinking", thinking: "THINKING_DETAIL" }, { type: "text", text },
], stopReason: "stop" });

test("cloud transcript updates actual Pi components and ignores replayed cursors", () => {
  const view = new CloudTranscript(tui, process.cwd());
  const start = event(1, { type: "message_start", message: message("partial") });
  view.apply(start);
  assert.ok(view.children[0] instanceof AssistantMessageComponent);
  const component = view.children[0];
  view.apply(event(2, { type: "message_update", message: message("STREAMED_中文") }));
  assert.equal(view.children[0], component, "streaming must update the existing native component");
  assert.match(view.render(60).join("\n"), /STREAMED_中文/);
  view.setHideThinking(true);
  assert.doesNotMatch(view.render(60).join("\n"), /THINKING_DETAIL/);
  view.setHideThinking(false);
  assert.match(view.render(60).join("\n"), /THINKING_DETAIL/);
  view.apply(event(3, { type: "message_end", message: message("FINAL") }));
  view.apply(start);
  assert.equal(view.children.length, 1);
  assert.match(view.render(60).join("\n"), /FINAL/);
  assert.doesNotMatch(view.render(60).join("\n"), /partial/);
  view.apply(event(4, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "remote follow-up" }] } }));
  assert.ok(view.children[1] instanceof UserMessageComponent);
});

test("structured history compacts streamed snapshots and restores without duplicates", () => {
  let history: TaskEvent[] = [];
  for (let cursor = 1; cursor <= 100; cursor++) {
    history = retainTranscriptEvent(history, event(cursor, {
      type: cursor === 1 ? "message_start" : cursor === 100 ? "message_end" : "message_update",
      message: message(`snapshot ${cursor}`),
    }));
  }
  assert.equal(history.length, 1, "do not persist a transcript copy for every token");
  assert.equal(history[0]?.cursor, 100);
  const restored = new CloudTranscript(tui, process.cwd());
  for (const item of history) restored.apply(item);
  restored.apply(history[0]!);
  assert.equal(restored.children.length, 1);
  assert.match(restored.render(60).join("\n"), /snapshot 100/);
});

test("plugin tool snapshots replace their row, retain styles and replay without duplicated tools", () => {
  const requests: unknown[] = [];
  const view = new CloudTranscript(tui, process.cwd(), request => requests.push(request));
  const start = event(1, { type: "tool_execution_start", toolCallId: "plugin-call", toolName: "plugin", args: {} });
  const compact = event(2, { type: "extension_tool_view", view: { toolCallId: "plugin-call", width: 80, expanded: false, lines: ["\u001b[32mPLUGIN_COMPACT\u001b[0m"] } });
  const expanded = event(3, { type: "extension_tool_view", view: { toolCallId: "plugin-call", width: 80, expanded: true, lines: ["PLUGIN_EXPANDED"] } });
  let history: TaskEvent[] = [];
  for (const item of [start, compact, expanded]) { view.apply(item); history = retainTranscriptEvent(history, item); }
  assert.match(view.render(60).join("\n"), /PLUGIN_COMPACT/);
  assert.equal(requests.length, 1);
  view.render(60);
  assert.equal(requests.length, 1, "rendering must not flood resize requests");
  view.setExpanded(true);
  assert.match(view.render(60).join("\n"), /PLUGIN_EXPANDED/);
  const restored = new CloudTranscript(tui, process.cwd());
  for (const item of history) restored.apply(item);
  assert.equal(restored.children.length, 1);
  assert.match(restored.render(80).join("\n"), /\u001b\[32mPLUGIN_COMPACT/);
});

test("cloud tool calls use native tools, expand results and sanitize terminal instructions", () => {
  const view = new CloudTranscript(tui, process.cwd());
  view.apply(event(1, { type: "message_end", message: { role: "assistant", content: [
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "not-a-local-file.txt" } },
  ] } }));
  view.apply(event(2, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "not-a-local-file.txt" } }));
  assert.equal(view.children.filter(child => child instanceof ToolExecutionComponent).length, 1);
  const lines = Array.from({ length: 40 }, (_, index) => `remote line ${index}`);
  view.apply(event(3, { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: true,
    result: { content: [{ type: "text", text: lines.join("\n") + "\n\x1b]52;c;CLIPBOARD\x07REMOTE_ERROR" }] } }));
  const collapsed = view.render(60).join("\n");
  view.setExpanded(true);
  const expanded = view.render(60).join("\n");
  assert.ok(expanded.length > collapsed.length, "native tool expansion must reveal more output");
  assert.match(expanded, /REMOTE_ERROR/);
  assert.doesNotMatch(expanded, /CLIPBOARD/);
  for (const width of [30, 60, 100]) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});
