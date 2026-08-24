import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createGitSnapshot,
  currentGitMatches,
  parseGitSnapshot,
  serializeGitSnapshot,
} from "../src/git.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

test("creates deterministic snapshots for tracked and selected untracked files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-git-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Pi Cloud Test");
  await writeFile(join(cwd, "tracked.txt"), "before\n");
  await git(cwd, "add", "tracked.txt");
  await git(cwd, "commit", "-qm", "initial");
  await writeFile(join(cwd, "tracked.txt"), "after\n");
  await writeFile(join(cwd, "selected.txt"), "untracked\n");
  const snapshot = await createGitSnapshot(cwd, ["selected.txt"]);
  const restored = parseGitSnapshot(serializeGitSnapshot(snapshot));

  assert.deepEqual(restored, snapshot);
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ["selected.txt", "tracked.txt"],
  );
  assert.equal(await currentGitMatches(cwd, snapshot.baseline), true);
  await writeFile(join(cwd, "tracked.txt"), "changed again\n");
  assert.equal(await currentGitMatches(cwd, snapshot.baseline), false);
});

test("rejects invalid snapshots", () => {
  assert.throws(() => parseGitSnapshot("{"), /invalid Git snapshot JSON/);
  assert.throws(() => parseGitSnapshot("{}"), /invalid Git snapshot$/);
});
