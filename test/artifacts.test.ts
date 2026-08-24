import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/worker/artifacts.js";

test("stores artifacts immutably by id", async () => {
  const store = await ArtifactStore.open(
    await mkdtemp(join(tmpdir(), "pi-cloud-artifacts-")),
  );
  const first = await store.put("result-1", Buffer.from("ok"));
  assert.equal(first.size, 2);
  await assert.rejects(
    () => store.put("result-1", Buffer.from("different")),
    /different content/,
  );
  assert.equal((await store.read("result-1")).toString(), "ok");
  await assert.rejects(
    () => store.put("../escape", Buffer.from("x")),
    /invalid artifact id/,
  );
});
