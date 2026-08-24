import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTaskRecords, saveTaskRecords } from "../src/worker/task-store.js";
import type { TaskRecord } from "../src/worker/tasks.js";

test("persists task records for worker restart recovery", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-task-store-"));
  const record = {
    task: { taskId: "task-1" },
    status: "running",
    cursor: 2,
    events: [],
    inputs: [],
  } as unknown as TaskRecord;
  await saveTaskRecords(dataDir, [record]);
  const restored = await loadTaskRecords(dataDir);
  assert.equal(restored[0]?.task.taskId, "task-1");
  assert.equal(restored[0]?.status, "running");
});
