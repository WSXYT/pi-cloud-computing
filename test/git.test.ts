import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createGitResultSnapshot,
  createGitSnapshot,
  createWorkspaceArchive,
  currentGitMatches,
  materializeWorkspaceArchive,
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

test("materializes a complete repository and creates a return snapshot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-workspace-source-"));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Pi Cloud Test");
  await writeFile(join(cwd, "tracked.txt"), "committed\n");
  await git(cwd, "add", "tracked.txt");
  await git(cwd, "commit", "-qm", "initial");
  await writeFile(join(cwd, "tracked.txt"), "local change\n");
  await writeFile(join(cwd, "extra.txt"), "selected untracked\n");

  const archive = await createWorkspaceArchive(cwd, ["extra.txt"]);
  const parent = await mkdtemp(join(tmpdir(), "pi-cloud-workspace-target-"));
  const destination = join(parent, "repo");
  await materializeWorkspaceArchive(archive, destination);
  assert.equal(await readFile(join(destination, "tracked.txt"), "utf8"), "local change\n");
  assert.equal(await readFile(join(destination, "extra.txt"), "utf8"), "selected untracked\n");

  await writeFile(join(destination, "tracked.txt"), "remote result\n");
  const result = await createGitResultSnapshot(destination, archive.snapshot.baseline);
  assert.deepEqual(result.files.map((file) => file.path), ["extra.txt", "tracked.txt"]);
});

test("rejects invalid snapshots", () => {
  assert.throws(() => parseGitSnapshot("{"), /invalid Git snapshot JSON/);
  assert.throws(() => parseGitSnapshot("{}"), /invalid Git snapshot$/);
});
