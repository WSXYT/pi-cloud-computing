import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runWorkerCli } from "../src/worker/cli.js";

test("worker pair prints one complete copy-paste command", async () => {
  const previous = process.env.PI_CLOUD_DATA_DIR;
  process.env.PI_CLOUD_DATA_DIR = await mkdtemp(
    join(tmpdir(), "pi-cloud-worker-cli-"),
  );
  const output: string[] = [];
  try {
    assert.equal(
      await runWorkerCli(["config", "set", "public-ip", "127.0.0.1"], (line) =>
        output.push(line),
      ),
      0,
    );
    assert.equal(
      await runWorkerCli(["worker", "pair"], (line) => output.push(line)),
      0,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CLOUD_DATA_DIR;
    else process.env.PI_CLOUD_DATA_DIR = previous;
  }
  assert.equal(
    output.some((line) =>
      line.startsWith("pair-command=/cloud-pair https://127.0.0.1:9443 "),
    ),
    true,
  );
  assert.equal(
    output.some((line) => line.startsWith("pairing-expires-at=")),
    true,
  );
});
