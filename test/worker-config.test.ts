import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
