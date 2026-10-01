import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startWorkerServer, type WorkerServer } from "../src/worker/server.js";

test("a duplicate Worker cannot restore or mutate the live owner's state", { timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-instance-"));
  const options = { dataDir: root, publicIp: "127.0.0.1", port: 0, piVersion: "0.85.1", nodeVersion: process.version, gitVersion: "git", enableExecution: false };
  const worker = await startWorkerServer(options);
  let duplicate: WorkerServer | undefined;
  try {
    const before = await readFile(join(root, "state.json"));
    await assert.rejects(async () => { duplicate = await startWorkerServer(options); }, /lock/i);
    assert.ok(before.equals(await readFile(join(root, "state.json"))), "duplicate startup must leave state untouched");
    await worker.close();
    duplicate = await startWorkerServer(options);
    assert.ok(before.equals(await readFile(join(root, "state.json"))), "a clean restart preserves identity");
  } finally {
    await duplicate?.close();
    await worker.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
