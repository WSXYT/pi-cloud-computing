import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyGitSnapshot } from "../src/result.js";
import { getGitBaseline, type GitSnapshot } from "../src/git.js";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) =>
    execFile("git", args, { cwd }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}

test("applies a result only when the local Git baseline still matches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-result-"));
  await git(cwd, "init");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "file.txt"), "before");
  await git(cwd, "add", "file.txt");
  await git(cwd, "commit", "-m", "initial");
  const baseline = await getGitBaseline(cwd, ["file.txt"]);
  const snapshot: GitSnapshot = {
    baseline,
    files: [
      {
        path: "file.txt",
        status: "modified",
        contentBase64: Buffer.from("after").toString("base64"),
      },
    ],
    snapshotSha256: "unused",
  };
  assert.deepEqual(await applyGitSnapshot(cwd, snapshot), ["file.txt"]);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "after");
});
