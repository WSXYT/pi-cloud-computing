import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CloudConnection } from "../src/client-network.js";
import { workerStorageError } from "../src/errors.js";
import type { ProtocolFrame, TaskSpec } from "../src/protocol.js";
import { createPairing } from "../src/worker/pairing.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";
import { startWorkerServer } from "../src/worker/server.js";

const task: TaskSpec = { taskId: "first", projectId: "test", prompt: "hello", runner: "host",
  environment: { piVersion: "test", nodeVersion: process.version, platform: process.platform, packages: [], resources: [], providers: [], secretVersions: [], warnings: [] },
  git: { head: "head", indexHash: "index", repositoryHash: "repo", worktreeHash: "tree", includedPaths: [] },
  session: { sessionId: "session", baseLeafId: null, lastEntryId: null, entriesSha256: "hash" }, artifacts: [], secretIds: [] };

test("disk-full errors keep a safe diagnosis, not raw paths or credentials", () => {
  const error = Object.assign(new Error("ENOSPC /private/path Bearer must-not-leak"), { code: "ENOSPC" });
  assert.deepEqual(workerStorageError(error).toProtocol(), { code: "WORKER_STORAGE_ERROR", params: { operation: "save_task_state", cause: "ENOSPC" }, retryable: false });
});

test("failed persistence is reported over WS and blocks new work before execution", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-storage-failure-"));
  const worker = await startWorkerServer({ dataDir: root, publicIp: "127.0.0.1", port: 0, piVersion: "test", nodeVersion: process.version, gitVersion: "git", enableExecution: false });
  const state = await loadWorkerState(root);
  const pairing = createPairing(state);
  await saveWorkerState(root, state);
  const connection = new CloudConnection(worker.url, state.certificateFingerprint!);
  await connection.pair(pairing.code);
  let socket: Awaited<ReturnType<CloudConnection["openEvents"]>> | undefined;
  try {
    await rename(join(root, "events"), join(root, "events-preserved"));
    await writeFile(join(root, "events"), "block directory creation");
    worker.tasks.create(task);
    for (let n = 0; n < 20 && (await connection.workerInfo()).capabilities.storageHealthy !== false; n++) await delay(25);
    assert.equal((await connection.workerInfo()).capabilities.storageHealthy, false);
    let receive: ((frame: ProtocolFrame) => void) | undefined;
    socket = await connection.openEvents(frame => receive?.(frame));
    for (const request of [{ type: "task_status", taskId: "first" }, { type: "task_create", task: { ...task, taskId: "second" } }] as const) {
      const response = new Promise<ProtocolFrame>(resolve => { receive = resolve; });
      connection.send(socket, request);
      const frame = await response;
      assert.equal(frame.type, "error");
      if (frame.type !== "error") throw new Error("expected error");
      assert.equal(frame.error.code, "WORKER_STORAGE_ERROR");
      assert.equal(frame.requestType, request.type);
      assert.equal(frame.error.params?.mayHaveStarted, false);
    }
    assert.equal(worker.tasks.get("second"), undefined);
  } finally {
    socket?.terminate();
    await assert.rejects(worker.close(), /Worker could not save task state/);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
