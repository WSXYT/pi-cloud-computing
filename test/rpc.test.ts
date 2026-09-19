import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

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

async function runFake(
  t: TestContext,
  script: string,
  command = process.execPath,
) {
  const tasks = new WorkerTaskManager();
  const record = tasks.create({
    ...task,
    taskId: `rpc-${Math.random().toString(36).slice(2)}`,
  });
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-rpc-"));
  let disposed = 0;
  const executor = new PiRpcExecutor(tasks, {
    command,
    baseArgs: [
      "-e",
      `const emit = (e) => console.log(JSON.stringify(e)); ${script}`,
      "--",
    ],
    cwd,
    shutdownTimeoutMs: 50,
    startupTimeoutMs: 2_000,
  });
  t.after(async () => {
    await executor.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const finished = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("fake RPC did not terminate")),
      5_000,
    );
    const unsubscribe = tasks.subscribe((event) => {
      if (
        event.kind === "status" &&
        ["completed", "failed", "aborted"].includes(
          String(event.payload.status),
        )
      ) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
  executor.start(record, undefined, cwd, async () => {
    disposed++;
    return {};
  });
  await finished;
  await executor.dispose();
  assert.equal(disposed, 1, "finalization must happen exactly once");
  return record;
}

test("runs a Pi RPC-compatible process and forwards its events", async (t) => {
  const record = await runFake(
    t,
    "process.stdin.once('data',()=>{ emit({type:'agent_start'}); emit({type:'agent_settled'}); })",
  );
  assert.equal(record.status, "completed");
  assert.ok(
    record.events.some((event) =>
      JSON.stringify(event.payload).includes("agent_settled"),
    ),
  );
});

test("does not report success for a nonzero exit after agent_settled", async (t) => {
  const record = await runFake(
    t,
    "process.stdin.once('data',()=>{ emit({type:'agent_settled'}); process.exitCode = 7; })",
  );
  assert.equal(record.status, "failed");
  assert.equal(record.result?.exitCode, 7);
});

test("does not mistake a settled model error for success", async (t) => {
  const record = await runFake(
    t,
    `process.stdin.once('data',()=>{
    emit({type:'message_end', message:{role:'assistant',stopReason:'error',errorMessage:'provider unavailable'}});
    emit({type:'agent_settled'});
  })`,
  );
  assert.equal(record.status, "failed");
  assert.equal(record.result?.error, "provider unavailable");
});

test("rejected prompts terminate even when Pi stays alive without settling", async (t) => {
  const record = await runFake(
    t,
    `setInterval(()=>{}, 1000); process.stdin.once('data',()=>{
    emit({id:'pi-cloud-initial',type:'response',command:'prompt',success:false,error:'Missing authentication'});
  })`,
  );
  assert.equal(record.status, "failed");
  assert.equal(record.result?.error, "Missing authentication");
});

test("a successful retry replaces an earlier model error", async (t) => {
  const record = await runFake(
    t,
    `process.stdin.once('data',()=>{
    emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'transient'}});
    emit({type:'auto_retry_start'});
    emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}});
    emit({type:'auto_retry_end',success:true});
    emit({type:'agent_settled'});
  })`,
  );
  assert.equal(record.status, "completed");
});

test("zero exit without settlement fails and spawn errors still finalize", async (t) => {
  const early = await runFake(
    t,
    "process.stdin.once('data',()=>process.exit(0))",
  );
  assert.equal(early.status, "failed");
  const missing = await runFake(
    t,
    "",
    join(tmpdir(), "pi-cloud-nonexistent-executable"),
  );
  assert.equal(missing.status, "failed");
  assert.match(missing.result?.error ?? "", /ENOENT/);
});

test("LF framing retains Unicode separators inside remote text", async (t) => {
  const record = await runFake(
    t,
    `process.stdin.once('data',()=>{
    emit({type:'message_end',message:{role:'assistant',stopReason:'stop',content:'a\\u2028b\\u2029中文'}});
    emit({type:'agent_settled'});
  })`,
  );
  const event = record.events.find(
    (event) =>
      (event.payload.rpc as { type?: string } | undefined)?.type ===
      "message_end",
  );
  assert.equal(
    (event?.payload.rpc as { message: { content: string } }).message.content,
    "a\u2028b\u2029中文",
  );
});

test("abort also finalizes and never turns the task into completed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-abort-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tasks = new WorkerTaskManager();
  const record = tasks.create(task);
  const executor = new PiRpcExecutor(tasks, {
    command: process.execPath,
    baseArgs: ["-e", "setInterval(()=>{}, 1000)", "--"],
    cwd,
  });
  let disposed = 0;
  executor.start(record, undefined, cwd, async () => {
    disposed++;
    return {};
  });
  tasks.abort(task.taskId);
  executor.abort(task.taskId);
  await executor.dispose();
  assert.equal(disposed, 1);
  assert.equal(record.status, "aborted");
});
