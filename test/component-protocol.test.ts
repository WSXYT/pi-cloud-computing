import assert from "node:assert/strict";
import test from "node:test";
import { parseComponentFrame, parseComponentInput } from "../src/component-protocol.js";
import { parseFrame } from "../src/protocol.js";

test("component protocol admits scoped text/style/input only, never callback code or terminal commands", () => {
  const frame = { type: "frame", id: "component-1", revision: 1, width: 80, lines: ["\x1b[31mhello\x1b[0m\x1b_pi:c\x07"] };
  assert.deepEqual(parseComponentFrame({ ...frame, execute: "never retained" }), frame);
  assert.deepEqual(parseFrame(JSON.stringify({ type: "task_component", taskId: "task", component: frame })), { type: "task_component", taskId: "task", component: frame });
  for (const line of ["\x1b]52;c;payload\x07", "\x1b[2J", "\x1b]0;title\x07", "new\nline"]) {
    assert.throws(() => parseComponentFrame({ ...frame, lines: [line] }));
  }
  for (const invalid of [{ width: 0 }, { width: 501 }, { revision: -1 }, { id: "../outside" }, { lines: Array(501).fill("row") }, { lines: ["x".repeat(16385)] }]) {
    assert.throws(() => parseComponentFrame({ ...frame, ...invalid }));
  }
  const input = { type: "input", id: "component-1", data: "\x1b[200~中文\x1b[201~" };
  assert.deepEqual(parseComponentInput(input), input);
  assert.throws(() => parseComponentInput({ ...input, data: "x".repeat(65537) }));
  assert.throws(() => parseComponentInput({ type: "resize", id: "component-1", width: 80, height: Infinity }));
  assert.throws(() => parseComponentInput({ type: "mouse", id: "component-1", event: { type: "execute" } }));
});
