import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { once } from "node:events";
import { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CloudConnection,
  CloudRequestError,
  normalizeFingerprint,
} from "../src/client-network.js";
import { createPairing } from "../src/worker/pairing.js";
import { startWorkerServer } from "../src/worker/server.js";
import { SecretStore } from "../src/worker/secrets.js";
import { ensureSelfSignedCertificate } from "../src/worker/tls.js";
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
    assert.equal(
      normalizeFingerprint(paired.certificateFingerprint),
      fingerprint,
    );
    let rejectedHttpRequests = 0;
    let rejectedUpgrades = 0;
    const countRequest = () => rejectedHttpRequests++;
    const countUpgrade = () => rejectedUpgrades++;
    worker.server.on("request", countRequest);
    worker.server.on("upgrade", countUpgrade);
    const wrongPin = new CloudConnection(worker.url, "00", paired.token);
    await assert.rejects(
      () => wrongPin.upload("wrong-pin", Buffer.from("blocked"), "text/plain"),
      /CERTIFICATE_MISMATCH/,
    );
    await assert.rejects(
      () => wrongPin.pair("private-pairing-code"),
      /CERTIFICATE_MISMATCH/,
    );
    await assert.rejects(
      () => wrongPin.uploadSecret("private-key", "must-not-leak"),
      /CERTIFICATE_MISMATCH/,
    );
    await assert.rejects(
      () => wrongPin.openEvents(() => undefined),
      /CERTIFICATE_MISMATCH/,
    );
    assert.equal(
      rejectedHttpRequests,
      0,
      "no HTTP headers or body may precede pin verification",
    );
    assert.equal(
      rejectedUpgrades,
      0,
      "no WebSocket authorization may precede pin verification",
    );
    worker.server.off("request", countRequest);
    worker.server.off("upgrade", countUpgrade);
    assert.equal(await connection.hasArtifact("first"), false, "first upload must see a 404 as absent");
    await assert.rejects(() => wrongPin.hasArtifact("first"), /CERTIFICATE_MISMATCH/);
    const unauthenticated = new CloudConnection(worker.url, fingerprint);
    await assert.rejects(() => unauthenticated.hasArtifact("first"), /401|AUTH_REQUIRED/, "authorization failure must not look like a cache miss");
    await connection.upload("first", Buffer.from("one"), "text/plain");
    assert.equal(await connection.hasArtifact("first"), true);
    assert.equal((await connection.download("first")).toString(), "one");
    await connection.upload("second", Buffer.from("two"), "text/plain");
    await connection.uploadSecret("pi-auth", '{"provider":"secret"}');
    assert.equal(
      await (await SecretStore.open(dataDir)).get("pi-auth"),
      '{"provider":"secret"}',
    );
    const socket = await connection.openEvents(() => undefined);
    socket.terminate();
  } finally {
    await worker.close();
  }
});

test("a stalled HTTP response cannot trigger the completed TLS handshake timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-timeout-"));
  const tls = await ensureSelfSignedCertificate(root, "127.0.0.1");
  let requests = 0;
  const server = createServer({ key: tls.privateKey, cert: tls.certificate }, () => { requests++; });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const original = TLSSocket.prototype.setTimeout;
  t.mock.method(TLSSocket.prototype, "setTimeout", function (this: TLSSocket, ms: number, callback?: () => void) {
    return original.call(this, ms === 30_000 ? 100 : ms, callback);
  });
  const connection = new CloudConnection(`https://127.0.0.1:${address.port}`, tls.fingerprint, "fixture-token");
  await assert.rejects(() => connection.download("stalled"), (error: unknown) => {
    assert.ok(error instanceof CloudRequestError);
    assert.equal(error.code, "HTTP_RESPONSE_TIMEOUT");
    assert.equal(error.progress.phase, "response");
    assert.equal(error.progress.operation, "artifact_download");
    assert.equal(error.progress.receivedBytes, 0);
    return true;
  });
  assert.equal(requests, 1, "the request reached HTTP only after the pin was verified");
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
    const connection = new CloudConnection(
      worker.url,
      state.certificateFingerprint,
    );
    const paired = await connection.pair(pairing.code);
    assert.ok(paired.token);
  } finally {
    await worker.close();
  }
});
