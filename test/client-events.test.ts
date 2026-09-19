import assert from "node:assert/strict";
import test from "node:test";
import { remoteEventView, safeDisplayText } from "../src/client-events.js";
import type { TaskEvent } from "../src/protocol.js";

const rpcEvent = (rpc: Record<string, unknown>): TaskEvent => ({ taskId: "task", cursor: 1, kind: "log", payload: { rpc } });

test("renders real RPC deltas, final answers, tool results and errors", () => {
  assert.deepEqual(remoteEventView(rpcEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello 中文" } })), { delta: "Hello 中文" });
  assert.deepEqual(remoteEventView(rpcEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } })), { text: "final answer", transcript: "final answer" });
  assert.match(remoteEventView(rpcEvent({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "file contents" }] } })).transcript!, /read\nfile contents/);
  assert.equal(remoteEventView(rpcEvent({ type: "response", success: false, error: "provider unavailable" })).transcript, "provider unavailable");
});

test("remote output cannot inject terminal controls and long lines keep streaming", () => {
  assert.equal(safeDisplayText("before\u001b]52;c;CLIPBOARD\u0007\u001b[2Jafter\u202e"), "beforeafter");
  const output = safeDisplayText(`${"中".repeat(100_000)}LATEST`);
  assert.ok(Buffer.byteLength(output) < 50 * 1024);
  assert.ok(output.startsWith("…"));
  assert.ok(output.endsWith("LATEST"));
  assert.ok(!output.includes("�"), "truncation must not split UTF-8 characters");
});
