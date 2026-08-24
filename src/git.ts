import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./environment.js";
import type { GitBaseline } from "./protocol.js";

const execFileAsync = promisify(execFile);

export interface GitSnapshotFile {
  path: string;
  status: "added" | "modified" | "deleted";
  mode?: string;
  sha256?: string;
  contentBase64?: string;
}

export interface GitSnapshot {
  baseline: GitBaseline;
  files: GitSnapshotFile[];
  snapshotSha256: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function parseNullSeparated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return item;
  });
}

async function readTrackedFile(
  cwd: string,
  path: string,
): Promise<GitSnapshotFile> {
  try {
    const content = await readFile(join(cwd, path));
    return {
      path,
      status: "modified",
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    };
  } catch {
    return { path, status: "deleted" };
  }
}

async function statusFiles(
  cwd: string,
): Promise<{ tracked: string[]; untracked: string[] }> {
  const output = await git(cwd, ["status", "--porcelain=v1", "-z"]);
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const entry of parseNullSeparated(output)) {
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path || status === "!!") continue;
    if (status === "??") untracked.push(path);
    else
      tracked.push(
        path.includes(" -> ") ? path.slice(path.lastIndexOf(" -> ") + 4) : path,
      );
  }
  return {
    tracked: [...new Set(tracked)].sort(),
    untracked: [...new Set(untracked)].sort(),
  };
}

export async function assertGitRepository(cwd: string): Promise<void> {
  await git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function getGitBaseline(
  cwd: string,
  includedPaths: string[] = [],
): Promise<GitBaseline> {
  await assertGitRepository(cwd);
  const { tracked, untracked } = await statusFiles(cwd);
  const selected = new Set(
    includedPaths.length > 0 ? includedPaths : untracked,
  );
  const files = [
    ...tracked,
    ...untracked.filter((path) => selected.has(path)),
  ].sort();
  const fileHashes: Array<{ path: string; sha256?: string; status: string }> =
    [];
  for (const path of files) {
    const file = await readTrackedFile(cwd, path);
    fileHashes.push({
      path,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      status: file.status,
    });
  }
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const indexHash = (await git(cwd, ["write-tree"])).trim();
  return {
    repositoryHash: sha256((await git(cwd, ["rev-parse", "--git-dir"])).trim()),
    head,
    indexHash,
    worktreeHash: sha256(stableJson(fileHashes)),
    includedPaths: files,
  };
}

export async function createGitSnapshot(
  cwd: string,
  includedUntracked: string[] = [],
): Promise<GitSnapshot> {
  const baseline = await getGitBaseline(cwd, includedUntracked);
  const files: GitSnapshotFile[] = [];
  for (const path of baseline.includedPaths)
    files.push(await readTrackedFile(cwd, path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    baseline,
    files,
    snapshotSha256: sha256(stableJson({ baseline, files })),
  };
}

export async function currentGitMatches(
  cwd: string,
  baseline: GitBaseline,
): Promise<boolean> {
  const current = await getGitBaseline(cwd, baseline.includedPaths);
  return (
    current.repositoryHash === baseline.repositoryHash &&
    current.head === baseline.head &&
    current.indexHash === baseline.indexHash &&
    current.worktreeHash === baseline.worktreeHash
  );
}

export function serializeGitSnapshot(snapshot: GitSnapshot): string {
  return `${stableJson(snapshot)}\n`;
}

export function parseGitSnapshot(value: string): GitSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid Git snapshot JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("baseline" in parsed) ||
    !("files" in parsed) ||
    !("snapshotSha256" in parsed)
  ) {
    throw new Error("invalid Git snapshot");
  }
  // SAFETY: callers receive the validated top-level snapshot shape; artifact-level field validation occurs before application.
  return parsed as GitSnapshot;
}
