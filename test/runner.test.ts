import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { resolve } from "node:path";

import { HostRunner, dockerArgs } from "../src/worker/runner.js";
import {
  defaultWorkerConfig,
  setWorkerConfigValue,
} from "../src/worker/config.js";

test("native runner terminates descendants as well as the task parent", { timeout: 15_000 }, async () => {
  const runner = new HostRunner();
  const child = runner.spawn(process.execPath, [resolve("test/fixtures/process-tree.mjs")], { windowsHide: true });
  const closed = once(child, "close");
  try {
    let output = "";
    for await (const chunk of child.stdout) {
      output += String(chunk);
      if (output.includes("tree-ready")) break;
    }
    assert.match(output, /tree-ready/);
    runner.terminate(child, "SIGKILL");
    // The grandchild inherits stderr too: close cannot arrive while it holds that pipe open.
    await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) runner.terminate(child, "SIGKILL");
  }
});

test("Docker runner keeps the worker process isolated", () => {
  const args = dockerArgs("pi-cloud:test", "/srv/workspace", "pi", [
    "--mode",
    "rpc",
    "--session",
    "/srv/workspace/session.jsonl",
  ]);
  for (const flag of [
    "--rm",
    "--init",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
  ])
    assert.ok(args.includes(flag));
  assert.ok(args.includes("/srv/workspace:/task"));
  assert.ok(args.includes("/task/session.jsonl"));
  assert.equal(args.includes("--privileged"), false);
  assert.equal(
    args.some((arg) => arg.includes("docker.sock")),
    false,
  );
});

test("Docker bridge egress is explicit and mounts only this task with credential names, not values", () => {
  const args = dockerArgs(
    "pi-cloud:test",
    "/srv/task/workspace",
    "node",
    ["/srv/task/runtime/bootstrap.mjs", "--session", "/srv/task/session.jsonl"],
    {
      root: "/srv/task",
      network: "bridge",
      envKeys: ["PI_CODING_AGENT_DIR", "SYNTHETIC_API_KEY"],
    },
  );
  assert.ok(args.includes("--network=bridge"));
  assert.ok(args.includes("/srv/task:/task"));
  assert.ok(args.includes("/task/workspace"));
  assert.ok(args.includes("/task/runtime/bootstrap.mjs"));
  assert.ok(args.includes("/task/session.jsonl"));
  assert.ok(args.includes("PI_CODING_AGENT_DIR"));
  assert.ok(args.includes("SYNTHETIC_API_KEY"));
  assert.equal(
    args.some((arg) => arg.startsWith("SYNTHETIC_API_KEY=")),
    false,
  );
  const config = setWorkerConfigValue(
    defaultWorkerConfig(),
    "docker-network",
    "bridge",
  );
  assert.equal(config.dockerNetwork, "bridge");
  assert.throws(
    () => setWorkerConfigValue(config, "docker-network", "host"),
    /none or bridge/,
  );
});
