import assert from "node:assert/strict";
import test from "node:test";

import { WorkerTaskManager } from "../src/worker/tasks.js";
import type { TaskSpec } from "../src/protocol.js";

const task = (taskId: string): TaskSpec => ({
  taskId,
  projectId: "project-1",
  prompt: "run tests",
  runner: "docker",
  environment: {
    piVersion: "0.84.2",
    nodeVersion: "24",
    platform: "linux",
    packages: [],
    resources: [],
    providers: [],
    secretVersions: [],
    warnings: [],
  },
  git: {
    repositoryHash: "repo",
    head: "head",
    indexHash: "index",
    worktreeHash: "tree",
    includedPaths: [],
  },
  session: {
    sessionId: "session-1",
    baseLeafId: null,
    lastEntryId: null,
    entriesSha256: "entries",
  },
  artifacts: [],
  secretIds: [],
});

test("queues tasks, records input events, and resumes after abort", () => {
  const manager = new WorkerTaskManager();
  const first = manager.create(task("task-1"));
  const second = manager.create(task("task-2"));
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  manager.input({
    taskId: "task-1",
    delivery: "followUp",
    message: "also check refresh",
  });
  assert.equal(manager.eventsAfter("task-1", 0).length, 2);
  manager.abort("task-1");
  assert.equal(manager.active()?.task.taskId, "task-2");
  assert.equal(
    manager.eventsAfter("task-1", 0).at(-1)?.payload.status,
    "aborted",
  );
});

test("replays only events after a cursor", () => {
  const manager = new WorkerTaskManager();
  manager.create(task("task-1"));
  manager.log("task-1", { line: 1 });
  manager.log("task-1", { line: 2 });
  assert.deepEqual(
    manager.eventsAfter("task-1", 1).map((event) => event.cursor),
    [2, 3],
  );
});
