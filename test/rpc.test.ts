import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkerTaskManager } from "../src/worker/tasks.js";
import { PiRpcExecutor } from "../src/worker/rpc.js";
import type { TaskSpec } from "../src/protocol.js";

const task: TaskSpec = {
  taskId: "rpc-task",
  projectId: "project-1",
  prompt: "run",
  runner: "host",
  environment: {
    piVersion: "0.84.2",
    nodeVersion: "24",
    platform: "win32",
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
};

test("runs a Pi RPC-compatible process and forwards its events", async () => {
  const tasks = new WorkerTaskManager();
  const record = tasks.create(task);
  const events: unknown[] = [];
  tasks.subscribe((event) => events.push(event.payload));
  const executor = new PiRpcExecutor(tasks, {
    command: process.execPath,
    baseArgs: [
      "-e",
      "process.stdin.on('data',()=>{ console.log(JSON.stringify({type:'agent_start'})); console.log(JSON.stringify({type:'agent_settled'})) })",
      "--",
    ],
    cwd: await mkdtemp(join(tmpdir(), "pi-cloud-rpc-")),
  });
  executor.start(
    record,
    join(await mkdtemp(join(tmpdir(), "pi-cloud-session-")), "session.jsonl"),
  );
  for (
    let attempt = 0;
    attempt < 40 && tasks.get("rpc-task")?.status === "running";
    attempt += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  executor.dispose();
  assert.equal(tasks.get("rpc-task")?.status, "completed");
  assert.equal(
    events.some((payload) => JSON.stringify(payload).includes("agent_settled")),
    true,
  );
});
