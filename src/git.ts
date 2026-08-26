import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

export interface WorkspaceArchive {
  bundleBase64: string;
  snapshot: GitSnapshot;
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

export async function createGitResultSnapshot(
  cwd: string,
  baseline: GitBaseline,
): Promise<GitSnapshot> {
  const { tracked, untracked } = await statusFiles(cwd);
  const committed = parseNullSeparated(
    await git(cwd, ["diff", "--name-only", "-z", baseline.head, "HEAD"]),
  );
  const paths = [...new Set([...tracked, ...untracked, ...committed])]
    .filter((path) => !path.startsWith(".pi-cloud-"))
    .sort();
  const files: GitSnapshotFile[] = [];
  for (const path of paths) files.push(await readTrackedFile(cwd, path));
  return {
    baseline,
    files,
    snapshotSha256: sha256(stableJson({ baseline, files })),
  };
}

export async function createWorkspaceArchive(
  cwd: string,
  includedUntracked: string[] = [],
): Promise<WorkspaceArchive> {
  const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-bundle-"));
  const bundlePath = join(temporary, "repository.bundle");
  try {
    await git(cwd, ["bundle", "create", bundlePath, "--all"]);
    return {
      bundleBase64: (await readFile(bundlePath)).toString("base64"),
      snapshot: await createGitSnapshot(cwd, includedUntracked),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function materializeWorkspaceArchive(
  archive: WorkspaceArchive,
  destination: string,
): Promise<void> {
  if (!archive.bundleBase64 || !archive.snapshot)
    throw new Error("invalid workspace archive");
  const temporary = join(tmpdir(), `pi-cloud-${randomUUID()}.bundle`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, Buffer.from(archive.bundleBase64, "base64"), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await execFileAsync("git", ["clone", "--quiet", temporary, destination], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const root = resolve(destination);
    for (const file of archive.snapshot.files) {
      const path = resolve(root, file.path);
      if (
        path !== root &&
        !path.startsWith(`${root}/`) &&
        !path.startsWith(`${root}\\`)
      )
        throw new Error(`workspace path escapes repository: ${file.path}`);
      if (file.status === "deleted") await rm(path, { force: true });
      else {
        if (!file.contentBase64)
          throw new Error(`workspace file has no content: ${file.path}`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(file.contentBase64, "base64"));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function serializeWorkspaceArchive(archive: WorkspaceArchive): string {
  return `${stableJson(archive)}\n`;
}

export function parseWorkspaceArchive(value: string): WorkspaceArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid workspace archive JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("bundleBase64" in parsed) ||
    !("snapshot" in parsed)
  )
    throw new Error("invalid workspace archive");
  return parsed as WorkspaceArchive;
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
