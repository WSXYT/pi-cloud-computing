import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTaskRecords, saveTaskRecords } from "../src/worker/task-store.js";
import type { TaskRecord } from "../src/worker/tasks.js";

test("journal recovery retains abort finalization until cleanup completes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-abort-journal-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const record = { task: { taskId: "task-1" }, status: "running", cursor: 0, events: [], inputs: [] } as unknown as TaskRecord;
  await saveTaskRecords(dataDir, [record]);
  const journal = join(dataDir, "events", "task-1.jsonl");
  const event = (cursor: number, payload: Record<string, unknown>) => JSON.stringify({ taskId: "task-1", cursor, kind: "status", payload }) + "\n";
  // Reproduce the window between the journal append and snapshot replacement.
  await appendFile(journal, event(1, { status: "aborted", finalizing: true }));
  const [stopping] = await loadTaskRecords(dataDir);
  assert.equal(stopping?.status, "aborted");
  assert.equal(stopping?.finalizing, true, "abort acknowledgement must not imply credentials are gone");
  await appendFile(journal, event(2, { status: "aborted" }));
  const [stopped] = await loadTaskRecords(dataDir);
  assert.equal(stopped?.finalizing, false);
  assert.equal(stopped?.cursor, 2);
});

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
