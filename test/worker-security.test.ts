import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completePairing,
  createPairing,
  authenticateToken,
  revokeToken,
} from "../src/worker/pairing.js";
import {
  certificateFingerprint,
  generateSelfSignedCertificate,
} from "../src/worker/tls.js";
import { newWorkerState } from "../src/worker/state.js";

test("pairing codes are single-use and tokens are revocable", () => {
  const state = newWorkerState();
  const pairing = createPairing(state, 1000);
  const token = completePairing(state, pairing.code, 1001);
  assert.equal(authenticateToken(state, token)?.id, state.tokens[0]?.id);
  assert.throws(() => completePairing(state, pairing.code, 1002), /not active/);
  assert.equal(revokeToken(state, state.tokens[0]!.id, 1003), true);
  assert.equal(authenticateToken(state, token), null);
});

test("generated certificate fingerprint is readable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-tls-"));
  const paths = await generateSelfSignedCertificate(dataDir, "127.0.0.1", 1);
  const fingerprint = await certificateFingerprint(paths.certificate);
  assert.match(fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});
