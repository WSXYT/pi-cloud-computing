import assert from "node:assert/strict";
import test from "node:test";

import { encodeFrame, parseFrame, parseTaskInput, type ClientFrame } from "../src/protocol.js";

test("round trips a hello frame", () => {
  const frame: ClientFrame = {
    type: "hello",
    protocolVersion: 1,
    clientId: "client-1",
  };
  assert.deepEqual(parseFrame(encodeFrame(frame)), frame);
});

test("rejects unsupported protocol versions", () => {
  assert.throws(
    () =>
      parseFrame(
        JSON.stringify({
          type: "hello",
          protocolVersion: 99,
          clientId: "client-1",
        }),
      ),
    /unsupported protocol version/,
  );
});

test("rejects malformed JSON and unknown frame types", () => {
  assert.throws(() => parseFrame("{"), /valid JSON/);
  assert.throws(
    () => parseFrame(JSON.stringify({ type: "unknown" })),
    /unknown frame type/,
  );
});

test("validates Worker replies before clients consume identities, cursors and artifacts", () => {
  for (const frame of [
    { type: "task_event", event: { taskId: "task", cursor: -1, kind: "log", payload: {} } },
    { type: "task_event", event: { taskId: "task", cursor: 1, kind: "log", payload: [] } },
    { type: "task_result", result: { taskId: "task", status: "completed", resultArtifactId: "../escape" } },
    { type: "task_state", state: { taskId: "task", status: "completed", cursor: 1, result: { taskId: "another-task", status: "completed" } } },
    { type: "task_accepted", taskId: "task", status: "invented" },
    { type: "hello_ack", protocolVersion: 99, worker: {} },
  ]) assert.throws(() => parseFrame(JSON.stringify(frame)));
  const valid = { type: "task_state", state: { taskId: "task", status: "aborted", cursor: 4, finalizing: true, result: { taskId: "task", status: "aborted" } } };
  assert.deepEqual(parseFrame(JSON.stringify(valid)), valid);
});

test("accepts image-only input while rejecting malformed image payloads", () => {
  const input = { taskId: "task", id: "input", delivery: "followUp", message: "", images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] };
  assert.deepEqual(parseTaskInput(input), input);
  assert.throws(() => parseTaskInput({ ...input, images: [] }));
  assert.throws(() => parseTaskInput({ ...input, images: [{ ...input.images[0], data: "invalid base64" }] }));
});
