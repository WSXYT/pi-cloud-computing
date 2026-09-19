import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  snapshotDigest,
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
  assert.equal(
    await readFile(join(destination, "tracked.txt"), "utf8"),
    "local change\n",
  );
  assert.equal(
    await readFile(join(destination, "extra.txt"), "utf8"),
    "selected untracked\n",
  );

  await writeFile(join(destination, "tracked.txt"), "remote result\n");
  const result = await createGitResultSnapshot(
    destination,
    archive.snapshot.baseline,
    archive.snapshot,
  );
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["tracked.txt"],
  );
});

test("round-trips empty files, nested untracked files and the staged index", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-git-cases-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = join(cwd, "source");
  await mkdir(source);
  await git(source, "init", "-q");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test");
  await writeFile(join(source, "file.txt"), "original");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "initial");
  await git(source, "checkout", "--detach", "-q");
  await writeFile(join(source, "file.txt"), "staged");
  await git(source, "add", "file.txt");
  await writeFile(join(source, "file.txt"), "");
  await mkdir(join(source, "new", "nested"), { recursive: true });
  await writeFile(join(source, "new", "nested", "empty.txt"), "");
  const archive = await createWorkspaceArchive(source);
  const destination = join(cwd, "destination");
  await materializeWorkspaceArchive(archive, destination);
  assert.equal(await readFile(join(destination, "file.txt"), "utf8"), "");
  assert.equal(
    await readFile(join(destination, "new", "nested", "empty.txt"), "utf8"),
    "",
  );
  assert.equal(
    (await run("git", ["show", ":file.txt"], { cwd: destination })).stdout,
    "staged",
  );
  assert.equal(
    (
      await run("git", ["rev-parse", "HEAD"], { cwd: destination })
    ).stdout.trim(),
    archive.snapshot.baseline.head,
  );
  assert.deepEqual(
    (
      await createGitResultSnapshot(
        destination,
        archive.snapshot.baseline,
        archive.snapshot,
      )
    ).files,
    [],
  );
  await writeFile(join(destination, "file.txt"), "original");
  await rm(join(destination, "new"), { recursive: true });
  const result = await createGitResultSnapshot(
    destination,
    archive.snapshot.baseline,
    archive.snapshot,
  );
  assert.deepEqual(
    result.files.map(({ path, status }) => ({ path, status })),
    [
      { path: "file.txt", status: "modified" },
      { path: "new/nested/empty.txt", status: "deleted" },
    ],
  );
});

test("rejects archive overlays through committed symlinks before writing outside the checkout", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-git-symlink-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = join(cwd, "source");
  const outside = join(cwd, "outside");
  await mkdir(source);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel.txt"), "untouched");
  await git(source, "init", "-q");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test");
  await writeFile(join(source, "file.txt"), "base");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "initial");
  await writeFile(join(source, "file.txt"), "poison");
  const archive = await createWorkspaceArchive(source);
  const linkTarget = join(cwd, "link-target.txt");
  await writeFile(linkTarget, outside.replaceAll("\\", "/"));
  const blob = (
    await run("git", ["hash-object", "-w", linkTarget], { cwd: source })
  ).stdout.trim();
  await git(
    source,
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${blob},out`,
  );
  await git(source, "commit", "-qm", "symlink");
  const bundle = join(cwd, "poison.bundle");
  await git(source, "bundle", "create", bundle, "--all", "HEAD");
  archive.bundleBase64 = (await readFile(bundle)).toString("base64");
  archive.snapshot.baseline.head = (
    await run("git", ["rev-parse", "HEAD"], { cwd: source })
  ).stdout.trim();
  archive.snapshot.files[0]!.path = "out/sentinel.txt";
  archive.snapshot.snapshotSha256 = snapshotDigest(archive.snapshot);
  await assert.rejects(
    () => materializeWorkspaceArchive(archive, join(cwd, "destination")),
    /symlink|not a directory/,
  );
  assert.equal(
    await readFile(join(outside, "sentinel.txt"), "utf8"),
    "untouched",
  );
});

test("rejects invalid snapshots", () => {
  assert.throws(() => parseGitSnapshot("{"), /invalid Git snapshot JSON/);
  assert.throws(() => parseGitSnapshot("{}"), /invalid Git snapshot$/);
});
