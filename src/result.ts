import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { currentGitMatches, type GitSnapshot } from "./git.js";

function safePath(cwd: string, relativePath: string): string {
  const root = resolve(cwd);
  const path = resolve(root, relativePath);
  if (
    path !== root &&
    !path.startsWith(`${root}/`) &&
    !path.startsWith(`${root}\\`)
  )
    throw new Error(`result path escapes workspace: ${relativePath}`);
  return path;
}

export async function applyGitSnapshot(
  cwd: string,
  snapshot: GitSnapshot,
): Promise<string[]> {
  if (!(await currentGitMatches(cwd, snapshot.baseline)))
    throw new Error("local base changed; remote result was not applied");
  const changed: string[] = [];
  for (const file of snapshot.files) {
    const path = safePath(cwd, file.path);
    if (file.status === "deleted") {
      await rm(path, { force: true });
    } else {
      if (!file.contentBase64)
        throw new Error(`result file has no content: ${file.path}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.contentBase64, "base64"));
    }
    changed.push(file.path);
  }
  return changed;
}

export function resultArtifactPath(
  dataDir: string,
  artifactId: string,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(artifactId))
    throw new Error("invalid result artifact id");
  return join(dataDir, "results", artifactId);
}
