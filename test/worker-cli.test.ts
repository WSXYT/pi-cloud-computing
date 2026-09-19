import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runWorkerCli } from "../src/worker/cli.js";
import { loadClientState } from "../src/client-state.js";

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

test("installer language command preserves paired connections and fails closed on corrupt recovery state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-installer-state-"));
  const path = join(root, "state.json");
  const previous = process.env.PI_CLOUD_CLIENT_STATE;
  process.env.PI_CLOUD_CLIENT_STATE = path;
  const connection = { baseUrl: "https://example.invalid", workerId: "worker", fingerprint: "aa".repeat(32), token: "fixture-token", pairedAt: new Date().toISOString() };
  try {
    await writeFile(path, `\uFEFF${JSON.stringify({ connections: [connection], activeWorkerId: "worker", locale: "en" })}`);
    assert.equal(await runWorkerCli(["client", "language", "zh-CN"], () => {}), 0);
    const saved = await loadClientState(path);
    assert.deepEqual(saved.connections, [connection]);
    assert.equal(saved.activeWorkerId, "worker");
    assert.equal(saved.locale, "zh-CN");
    assert.notEqual((await readFile(path, "utf8")).charCodeAt(0), 0xfeff);
    await writeFile(path, "{ corrupt existing recovery state");
    await assert.rejects(() => runWorkerCli(["client", "language", "en"], () => {}));
    assert.equal(await readFile(path, "utf8"), "{ corrupt existing recovery state");
  } finally {
    if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
    else process.env.PI_CLOUD_CLIENT_STATE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
