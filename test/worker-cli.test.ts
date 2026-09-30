import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

test("starts and stops a native Worker process with a verified local health check", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-native-serve-"));
  const previous = process.env.PI_CLOUD_DATA_DIR;
  process.env.PI_CLOUD_DATA_DIR = root;
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await runWorkerCli(["config", "set", "runner", "host"], () => {});
    await runWorkerCli(["config", "set", "port", String(address.port)], () => {});
    await runWorkerCli(["worker", "install", "--ip", "127.0.0.1"], () => {});
    child = spawn(process.execPath, ["dist/src/cli.js", "worker", "serve"], { env: { ...process.env, PI_CLOUD_DATA_DIR: root }, stdio: "pipe" });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) break;
      try { await runWorkerCli(["worker", "health"], () => {}); ready = true; break; }
      catch { await delay(100); }
    }
    assert.ok(ready, "native Worker did not pass its pinned local health check");
  } finally {
    if (child && child.exitCode === null) {
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child.kill("SIGTERM");
      await closed;
    }
    if (previous === undefined) delete process.env.PI_CLOUD_DATA_DIR;
    else process.env.PI_CLOUD_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
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
