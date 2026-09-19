import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadWorkerConfig,
  saveWorkerConfig,
  setWorkerConfigValue,
} from "../src/worker/config.js";
import { loadWorkerState } from "../src/worker/state.js";

test("persists worker config and creates state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-worker-"));
  let config = await loadWorkerConfig(dataDir);
  config = setWorkerConfigValue(config, "language", "zh-CN");
  config = setWorkerConfigValue(config, "runner", "host");
  await saveWorkerConfig(config);
  const reloaded = await loadWorkerConfig(dataDir);
  const state = await loadWorkerState(dataDir);
  assert.equal(reloaded.locale, "zh-CN");
  assert.equal(reloaded.runner, "host");
  assert.match(await readFile(join(dataDir, "state.json"), "utf8"), /workerId/);
  assert.equal(state.tokens.length, 0);
});

test("corrupt Worker config cannot silently reset security or overwrite the original", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-config-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, "config.json");
  const config = setWorkerConfigValue(await loadWorkerConfig(dataDir), "runner", "host");
  await writeFile(path, `\uFEFF${JSON.stringify(config)}`);
  assert.equal((await loadWorkerConfig(dataDir)).runner, "host");
  for (const text of ["{ corrupt", "null", "[]"]) {
    await writeFile(path, text);
    await assert.rejects(() => loadWorkerConfig(dataDir));
    assert.equal(await readFile(path, "utf8"), text);
  }
});
