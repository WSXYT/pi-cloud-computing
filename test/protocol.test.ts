import assert from "node:assert/strict";
import test from "node:test";

import { encodeFrame, parseFrame, type ClientFrame } from "../src/protocol.js";

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
