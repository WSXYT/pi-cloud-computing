import assert from "node:assert/strict";
import test from "node:test";

import { dockerArgs } from "../src/worker/runner.js";

test("Docker runner keeps the worker process isolated", () => {
  const args = dockerArgs("pi-cloud:test", "/srv/workspace", "pi", [
    "--mode",
    "rpc",
    "--session",
    "/srv/workspace/tasks/task-1/session.jsonl",
  ]);
  assert.deepEqual(args, [
    "run",
    "--rm",
    "-i",
    "--network=none",
    "--read-only",
    "-v",
    "/srv/workspace:/workspace",
    "-w",
    "/workspace",
    "pi-cloud:test",
    "pi",
    "--mode",
    "rpc",
    "--session",
    "/workspace/tasks/task-1/session.jsonl",
  ]);
});
