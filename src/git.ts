import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./environment.js";
import { decodeBase64, safeFilePath, validateRelativePath } from "./paths.js";
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
  indexPatch?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

function parseNullSeparated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return item;
  });
}

export function snapshotDigest(
  snapshot: Pick<GitSnapshot, "baseline" | "files">,
): string {
  return sha256(
    stableJson({ baseline: snapshot.baseline, files: snapshot.files }),
  );
}

async function readTrackedFile(
  cwd: string,
  path: string,
): Promise<GitSnapshotFile> {
  try {
    const absolute = await safeFilePath(cwd, path);
    const info = await lstat(absolute);
    const indexedMode = (
      await git(cwd, ["ls-files", "--stage", "--", path])
    ).slice(0, 6);
    if (indexedMode === "120000" || indexedMode === "160000")
      throw new Error(
        `modified symlinks/submodules are not supported: ${path}`,
      );
    const mode =
      process.platform === "win32"
        ? indexedMode === "100755"
          ? "100755"
          : "100644"
        : info.mode & 0o111
          ? "100755"
          : "100644";
    const content = await readFile(absolute);
    return {
      path,
      status: "modified",
      mode,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path, status: "deleted" };
  }
}

async function statusFiles(
  cwd: string,
): Promise<{ tracked: string[]; untracked: string[] }> {
  // --no-renames avoids porcelain -z's extra rename record; ls-files expands new directories.
  const tracked = parseNullSeparated(
    await git(cwd, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]),
  );
  const untracked = parseNullSeparated(
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  return {
    tracked: [...new Set(tracked)].sort(),
    untracked: [...new Set(untracked)].sort(),
  };
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function assertGitRepository(cwd: string): Promise<void> {
  await repositoryRoot(cwd);
  await git(cwd, ["rev-parse", "--verify", "HEAD"]);
}

export async function getGitBaseline(
  cwd: string,
  includedPaths?: string[],
): Promise<GitBaseline> {
  const root = await repositoryRoot(cwd);
  const { tracked, untracked } = await statusFiles(root);
  const selected = new Set(includedPaths ?? untracked);
  const files = [
    ...new Set([...tracked, ...untracked.filter((path) => selected.has(path))]),
  ].sort();
  // Include *all* local non-ignored changes in the guard, even files not uploaded.
  const fileHashes = [];
  for (const path of [...new Set([...tracked, ...untracked])].sort()) {
    const file = await readTrackedFile(root, path);
    fileHashes.push({
      path,
      sha256: file.sha256,
      mode: file.mode,
      status: file.status,
    });
  }
  return {
    repositoryHash: sha256(
      resolve((await git(root, ["rev-parse", "--absolute-git-dir"])).trim()),
    ),
    head: (await git(root, ["rev-parse", "HEAD"])).trim(),
    indexHash: (await git(root, ["write-tree"])).trim(),
    worktreeHash: sha256(stableJson(fileHashes)),
    includedPaths: files,
  };
}

export async function createGitSnapshot(
  cwd: string,
  includedUntracked?: string[],
): Promise<GitSnapshot> {
  const root = await repositoryRoot(cwd);
  const baseline = await getGitBaseline(root, includedUntracked);
  const files: GitSnapshotFile[] = [];
  for (const path of baseline.includedPaths)
    files.push(await readTrackedFile(root, path));
  return {
    baseline,
    files,
    snapshotSha256: snapshotDigest({ baseline, files }),
  };
}

async function readTreeFile(
  cwd: string,
  head: string,
  path: string,
): Promise<GitSnapshotFile> {
  const entry = await git(cwd, ["ls-tree", "-z", head, "--", path]);
  if (!entry) return { path, status: "deleted" };
  const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry);
  if (!match)
    throw new Error(
      `symlinks/submodules are not supported in results: ${path}`,
    );
  const { stdout } = await execFileAsync(
    "git",
    ["cat-file", "blob", match[2]!],
    {
      cwd,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return {
    path,
    status: "modified",
    mode: match[1]!,
    sha256: sha256(stdout),
    contentBase64: stdout.toString("base64"),
  };
}

export async function createGitResultSnapshot(
  cwd: string,
  baseline: GitBaseline,
  uploaded?: GitSnapshot,
): Promise<GitSnapshot> {
  const root = await repositoryRoot(cwd);
  const { tracked, untracked } = await statusFiles(root);
  const committed = parseNullSeparated(
    await git(root, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      baseline.head,
      "HEAD",
      "--",
    ]),
  );
  const paths = [
    ...new Set([
      ...baseline.includedPaths,
      ...tracked,
      ...untracked,
      ...committed,
    ]),
  ]
    .filter((path) => !path.startsWith(".pi-cloud-"))
    .sort();
  const originals = new Map(uploaded?.files.map((file) => [file.path, file]));
  const files: GitSnapshotFile[] = [];
  for (const path of paths) {
    const before =
      originals.get(path) ?? (await readTreeFile(root, baseline.head, path));
    const after = await readTrackedFile(root, path);
    if (before.status === "deleted" && after.status === "deleted") continue;
    if (
      before.status !== "deleted" &&
      after.status !== "deleted" &&
      before.sha256 === after.sha256 &&
      (before.mode ?? "100644") === after.mode
    )
      continue;
    if (before.status === "deleted" && after.status !== "deleted")
      after.status = "added";
    files.push(after);
  }
  return {
    baseline,
    files,
    snapshotSha256: snapshotDigest({ baseline, files }),
  };
}

export async function createWorkspaceArchive(
  cwd: string,
  includedUntracked?: string[],
): Promise<WorkspaceArchive> {
  const root = await repositoryRoot(cwd);
  const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-bundle-"));
  const bundlePath = join(temporary, "repository.bundle");
  try {
    const snapshot = await createGitSnapshot(root, includedUntracked);
    await git(root, ["bundle", "create", bundlePath, "--all", "HEAD"]);
    const indexPatch = await git(root, [
      "diff",
      "--cached",
      "--binary",
      "HEAD",
      "--",
    ]);
    if (!(await currentGitMatches(root, snapshot.baseline)))
      throw new Error(
        "workspace changed while taking the snapshot; submit again",
      );
    return {
      bundleBase64: (await readFile(bundlePath)).toString("base64"),
      snapshot,
      indexPatch,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function materializeWorkspaceArchive(
  archive: WorkspaceArchive,
  destination: string,
): Promise<void> {
  validateGitSnapshot(archive.snapshot);
  const bundle = decodeBase64(archive.bundleBase64);
  if (!bundle.length) throw new Error("invalid workspace archive");
  const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-checkout-"));
  const bundlePath = join(temporary, "repository.bundle");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(bundlePath, bundle, { mode: 0o600, flag: "wx" });
  try {
    await git(temporary, [
      "clone",
      "--quiet",
      "--no-checkout",
      bundlePath,
      resolve(destination),
    ]);
    await git(destination, [
      "checkout",
      "--quiet",
      "--detach",
      archive.snapshot.baseline.head,
    ]);
    const paths = await Promise.all(
      archive.snapshot.files.map((file) =>
        safeFilePath(destination, file.path),
      ),
    );
    for (const [index, file] of archive.snapshot.files.entries()) {
      const path = paths[index]!;
      if (file.status === "deleted") await rm(path, { force: true });
      else {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, decodeBase64(file.contentBase64));
        if (file.mode && process.platform !== "win32")
          await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
      }
    }
    if (archive.indexPatch) {
      const patchPath = join(temporary, "index.patch");
      await writeFile(patchPath, archive.indexPatch, { mode: 0o600 });
      await git(destination, ["apply", "--cached", "--binary", patchPath]);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
  const archive = parsed as WorkspaceArchive;
  decodeBase64(archive.bundleBase64);
  validateGitSnapshot(archive.snapshot);
  if (
    archive.indexPatch !== undefined &&
    typeof archive.indexPatch !== "string"
  )
    throw new Error("invalid index patch");
  return archive;
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

export function validateGitSnapshot(
  value: unknown,
): asserts value is GitSnapshot {
  if (!value || typeof value !== "object")
    throw new Error("invalid Git snapshot");
  const snapshot = value as GitSnapshot;
  const base = snapshot.baseline;
  if (
    !base ||
    !Array.isArray(snapshot.files) ||
    !Array.isArray(base.includedPaths) ||
    ![base.repositoryHash, base.worktreeHash].every(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    ) ||
    ![base.head, base.indexHash].every(
      (hash) =>
        typeof hash === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash),
    )
  )
    throw new Error("invalid Git snapshot");
  for (const path of base.includedPaths) validateRelativePath(path);
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (!file || typeof file !== "object")
      throw new Error("invalid Git snapshot file");
    validateRelativePath(file.path);
    const identity =
      process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (paths.has(identity))
      throw new Error(`duplicate snapshot path: ${file.path}`);
    paths.add(identity);
    if (!["added", "modified", "deleted"].includes(file.status))
      throw new Error("invalid snapshot file status");
    if (
      file.mode !== undefined &&
      file.mode !== "100644" &&
      file.mode !== "100755"
    )
      throw new Error("invalid snapshot file mode");
    if (
      file.status !== "deleted" &&
      sha256(decodeBase64(file.contentBase64)) !== file.sha256
    )
      throw new Error(`snapshot file hash mismatch: ${file.path}`);
  }
  if (snapshotDigest(snapshot) !== snapshot.snapshotSha256)
    throw new Error("Git snapshot hash mismatch");
}

export function parseGitSnapshot(value: string): GitSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid Git snapshot JSON");
  }
  validateGitSnapshot(parsed);
  return parsed;
}
