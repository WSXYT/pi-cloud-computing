import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloudConnection, normalizeFingerprint } from "../src/client-network.js";
import { createPairing } from "../src/worker/pairing.js";
import { startWorkerServer } from "../src/worker/server.js";
import { SecretStore } from "../src/worker/secrets.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";

test("keeps the verified certificate pin across pairing, uploads, and WSS", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-client-network-"));
  const initial = await loadWorkerState(dataDir);
  const pairing = createPairing(initial);
  await saveWorkerState(dataDir, initial);
  const worker = await startWorkerServer({
    dataDir,
    publicIp: "127.0.0.1",
    piVersion: "0.84.2",
    nodeVersion: process.version,
    gitVersion: "git",
    port: 0,
    enableExecution: false,
  });
  try {
    const state = await loadWorkerState(dataDir);
    assert.ok(state.certificateFingerprint);
    const fingerprint = normalizeFingerprint(state.certificateFingerprint);
    const connection = new CloudConnection(worker.url, fingerprint);
    const paired = await connection.pair(pairing.code);
    assert.equal(normalizeFingerprint(paired.certificateFingerprint), fingerprint);
    const wrongPin = new CloudConnection(worker.url, "00", paired.token);
    await assert.rejects(() => wrongPin.upload("wrong-pin", Buffer.from("blocked"), "text/plain"), /CERTIFICATE_MISMATCH/);
    await connection.upload("first", Buffer.from("one"), "text/plain");
    await connection.upload("second", Buffer.from("two"), "text/plain");
    await connection.uploadSecret("pi-auth", "{\"provider\":\"secret\"}");
    assert.equal(await (await SecretStore.open(dataDir)).get("pi-auth"), "{\"provider\":\"secret\"}");
    const socket = await connection.openEvents(() => undefined);
    socket.terminate();
  } finally {
    await worker.close();
  }
});

test("accepts a new one-time pairing code without restarting the Worker", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-live-pair-"));
  const worker = await startWorkerServer({
    dataDir,
    publicIp: "127.0.0.1",
    piVersion: "0.84.2",
    nodeVersion: process.version,
    gitVersion: "git",
    port: 0,
    enableExecution: false,
  });
  try {
    const state = await loadWorkerState(dataDir);
    const pairing = createPairing(state);
    await saveWorkerState(dataDir, state);
    assert.ok(state.certificateFingerprint);
    const connection = new CloudConnection(worker.url, state.certificateFingerprint);
    const paired = await connection.pair(pairing.code);
    assert.ok(paired.token);
  } finally {
    await worker.close();
  }
});
