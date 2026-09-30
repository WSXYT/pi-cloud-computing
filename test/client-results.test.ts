import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedResultArtifact } from "../src/client-results.js";

test("validated result copies remain usable offline without applying a session", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-result-cache-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const raw = Buffer.from(JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: new Date().toISOString(), cwd: root }) + "\n");
  assert.deepEqual(await cachedResultArtifact(root, "session", "result", async () => raw), raw);
  assert.deepEqual(await cachedResultArtifact(root, "session", "result", async () => { throw new Error("offline"); }), raw);
  assert.deepEqual(await readFile(join(root, "session-result")), raw);
});

test("invalid results and escaping cache IDs never become saved results", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-result-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(cachedResultArtifact(root, "git", "broken", async () => Buffer.from("{}")));
  await assert.rejects(cachedResultArtifact(root, "session", "../escape", async () => Buffer.from("{}")));
  assert.deepEqual(await readdir(root), []);
});
