import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_VERSION, RECOMMENDATION_PLACEHOLDERS } from "../src/index.js";

test("exports protocol version", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(RECOMMENDATION_PLACEHOLDERS.relay.enabled, false);
});
