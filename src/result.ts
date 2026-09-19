import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  currentGitMatches,
  repositoryRoot,
  validateGitSnapshot,
  type GitSnapshot,
} from "./git.js";
import { decodeBase64, safeFilePath } from "./paths.js";
import type { GitBaseline } from "./protocol.js";

const run = promisify(execFile);

async function replaceFile(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.pi-cloud-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function applyGitSnapshot(
  cwd: string,
  snapshot: GitSnapshot,
  expectedBaseline: GitBaseline = snapshot.baseline,
): Promise<string[]> {
  validateGitSnapshot(snapshot);
  for (const key of [
    "repositoryHash",
    "head",
    "indexHash",
    "worktreeHash",
  ] as const) {
    if (snapshot.baseline[key] !== expectedBaseline[key])
      throw new Error(
        "remote result does not match the locally saved submission baseline",
      );
  }
  const root = await repositoryRoot(cwd);
  if (!(await currentGitMatches(root, expectedBaseline)))
    throw new Error("local base changed; remote result was not applied");
  if (!snapshot.files.length) return [];

  const tracked = new Set(
    (await run("git", ["ls-files", "-z"], { cwd: root })).stdout.split("\0"),
  );
  const plan = [];
  for (const file of snapshot.files) {
    const path = await safeFilePath(root, file.path);
    let previous: Buffer | undefined;
    let mode = 0o644;
    try {
      previous = await readFile(path);
      mode = (await lstat(path)).mode & 0o777;
      if (
        !tracked.has(file.path) &&
        !expectedBaseline.includedPaths.includes(file.path)
      )
        throw new Error(
          `result would overwrite a file excluded from upload: ${file.path}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    plan.push({ file, path, previous, mode });
  }
  // Validate every target before changing any file. Keep preimages outside the worktree.
  const gitPath = (
    await run("git", ["rev-parse", "--git-path", "pi-cloud-backups"], {
      cwd: root,
    })
  ).stdout.trim();
  const backupPath = join(
    resolve(root, gitPath),
    `${Date.now()}-${randomUUID()}.json`,
  );
  await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
  await writeFile(
    backupPath,
    JSON.stringify({
      snapshot,
      originals: plan.map(({ file, previous, mode }) => ({
        path: file.path,
        mode,
        contentBase64: previous?.toString("base64"),
      })),
    }),
    { mode: 0o600, flag: "wx" },
  );
  if (!(await currentGitMatches(root, expectedBaseline)))
    throw new Error(
      "local base changed during result review; remote result was not applied",
    );

  const applied: typeof plan = [];
  try {
    for (const item of plan) {
      await safeFilePath(root, item.file.path);
      if (item.file.status === "deleted") await rm(item.path, { force: true });
      else
        await replaceFile(
          item.path,
          decodeBase64(item.file.contentBase64),
          item.file.mode === "100755" ? 0o755 : 0o644,
        );
      applied.push(item);
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const item of applied.reverse()) {
      try {
        await safeFilePath(root, item.file.path);
        if (item.previous === undefined) await rm(item.path, { force: true });
        else await replaceFile(item.path, item.previous, item.mode);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    throw new AggregateError(
      failures,
      `result application failed; recovery backup: ${backupPath}`,
    );
  }
  return plan.map(({ file }) => file.path);
}

export function resultArtifactPath(
  dataDir: string,
  artifactId: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(artifactId))
    throw new Error("invalid result artifact id");
  return join(dataDir, "results", artifactId);
}
