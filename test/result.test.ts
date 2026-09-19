import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

import { sha256 } from "../src/environment.js";
import { applyGitSnapshot } from "../src/result.js";
import {
  getGitBaseline,
  parseGitSnapshot,
  snapshotDigest,
  type GitSnapshot,
} from "../src/git.js";
import type { GitBaseline } from "../src/protocol.js";

const run = promisify(execFile);

async function repository(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-result-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ])
    await run("git", args, { cwd });
  await writeFile(join(cwd, "file.txt"), "before");
  await run("git", ["add", "file.txt"], { cwd });
  await run("git", ["commit", "-qm", "initial"], { cwd });
  return cwd;
}

function result(
  baseline: GitBaseline,
  contents: Record<string, string>,
): GitSnapshot {
  const files = Object.entries(contents).map(([path, content]) => ({
    path,
    status: "modified" as const,
    sha256: sha256(content),
    contentBase64: Buffer.from(content).toString("base64"),
  }));
  return {
    baseline,
    files,
    snapshotSha256: snapshotDigest({ baseline, files }),
  };
}

test("applies a result only when the local Git baseline still matches", async (t) => {
  const cwd = await repository(t);
  const baseline = await getGitBaseline(cwd);
  const snapshot = result(baseline, { "file.txt": "after" });
  assert.deepEqual(await applyGitSnapshot(cwd, snapshot), ["file.txt"]);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "after");
  await assert.rejects(
    () => applyGitSnapshot(cwd, snapshot),
    /local base changed/,
  );
});

test("supports empty result files", async (t) => {
  const cwd = await repository(t);
  await applyGitSnapshot(
    cwd,
    result(await getGitBaseline(cwd), { "file.txt": "", "empty.txt": "" }),
  );
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "");
  assert.equal(await readFile(join(cwd, "empty.txt"), "utf8"), "");
});

test("new local files invalidate the baseline even when upload selection is nonempty", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "file.txt"), "uploaded dirty content");
  const snapshot = result(await getGitBaseline(cwd), {
    "file.txt": "remote",
    "new.txt": "remote",
  });
  await writeFile(join(cwd, "new.txt"), "local work");
  await assert.rejects(
    () => applyGitSnapshot(cwd, snapshot),
    /local base changed/,
  );
  assert.equal(
    await readFile(join(cwd, "file.txt"), "utf8"),
    "uploaded dirty content",
  );
  assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "local work");
});

test("does not overwrite excluded or ignored local files", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, ".git", "info", "exclude"), "ignored.txt\n");
  await writeFile(join(cwd, "ignored.txt"), "private local data");
  const snapshot = result(await getGitBaseline(cwd, []), {
    "file.txt": "remote",
    "ignored.txt": "remote",
  });
  await assert.rejects(
    () => applyGitSnapshot(cwd, snapshot),
    /excluded from upload/,
  );
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "before");
  assert.equal(
    await readFile(join(cwd, "ignored.txt"), "utf8"),
    "private local data",
  );
});

test("validates the entire result before mutating any file", async (t) => {
  const cwd = await repository(t);
  const baseline = await getGitBaseline(cwd);
  for (const path of [
    "../escape.txt",
    ".git/config",
    ".GIT/config",
    "C:/escape.txt",
    "/tmp/escape.txt",
    "dir/../escape.txt",
  ]) {
    const snapshot = result(baseline, {
      "file.txt": "remote",
      [path]: "remote",
    });
    await assert.rejects(
      () => applyGitSnapshot(cwd, snapshot),
      /unsafe archive path/,
    );
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "before");
  }
  const tampered = result(baseline, { "file.txt": "remote" });
  tampered.files[0]!.contentBase64 = Buffer.from("tampered").toString("base64");
  assert.throws(
    () => parseGitSnapshot(JSON.stringify(tampered)),
    /hash mismatch/,
  );
  await assert.rejects(() => applyGitSnapshot(cwd, tampered), /hash mismatch/);
  const duplicate = result(baseline, { "file.txt": "remote" });
  duplicate.files.push(duplicate.files[0]!);
  duplicate.snapshotSha256 = snapshotDigest(duplicate);
  await assert.rejects(
    () => applyGitSnapshot(cwd, duplicate),
    /duplicate snapshot path/,
  );
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "before");
});

test("rejects a result that substitutes the persisted submission baseline", async (t) => {
  const cwd = await repository(t);
  const submitted = await getGitBaseline(cwd);
  await writeFile(join(cwd, "file.txt"), "new local work");
  const untrusted = result(await getGitBaseline(cwd), {
    "file.txt": "overwrite",
  });
  await assert.rejects(
    () => applyGitSnapshot(cwd, untrusted, submitted),
    /locally saved submission baseline/,
  );
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "new local work");
});

test("does not follow local symlinks or junctions", async (t) => {
  const cwd = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), "pi-cloud-sentinel-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "sentinel.txt"), "untouched");
  await mkdir(join(cwd, "nested"));
  const snapshot = result(await getGitBaseline(cwd), {
    "file.txt": "remote",
    "nested/link/sentinel.txt": "overwrite",
  });
  await symlink(
    outside,
    join(cwd, "nested", "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    () => applyGitSnapshot(cwd, snapshot),
    /symlink|local base changed/,
  );
  assert.equal(
    await readFile(join(outside, "sentinel.txt"), "utf8"),
    "untouched",
  );
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "before");
});
