import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensurePrivateDirectory, writePrivateFile } from "../src/storage.js";

test("private storage writes atomically and refuses to write before Windows ACL setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-private-"));
  const previousRoot = process.env.SystemRoot;
  const path = join(dir, "secret.json");
  try {
    await ensurePrivateDirectory(dir);
    await writePrivateFile(path, "private");
    assert.equal(await readFile(path, "utf8"), "private");
    if (process.platform === "win32") {
      process.env.SystemRoot = join(dir, "missing-system-root");
      await assert.rejects(writePrivateFile(join(dir, "blocked.json"), "secret"));
      assert.deepEqual((await readdir(dir)).sort(), ["secret.json"]);
      assert.equal(await readFile(path, "utf8"), "private");
    }
  } finally {
    if (previousRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousRoot;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
