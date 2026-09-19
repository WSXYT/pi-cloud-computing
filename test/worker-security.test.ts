import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
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
  ensureSelfSignedCertificate,
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

test("TLS rotation changes the pin and SAN; ordinary restarts never silently rotate", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-rotate-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const initial = await ensureSelfSignedCertificate(dataDir, "127.0.0.1");
  assert.equal((await ensureSelfSignedCertificate(dataDir, "127.0.0.1")).fingerprint, initial.fingerprint);
  await assert.rejects(() => ensureSelfSignedCertificate(dataDir, "127.0.0.2"), /does not cover/);
  const rotated = await ensureSelfSignedCertificate(dataDir, "127.0.0.2", true);
  assert.notEqual(rotated.fingerprint, initial.fingerprint);
  assert.equal(new X509Certificate(rotated.certificate).checkIP("127.0.0.2"), "127.0.0.2");
  await assert.rejects(() => ensureSelfSignedCertificate(dataDir, "127.0.0.1"), /does not cover/);
});
