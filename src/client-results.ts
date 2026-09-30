import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateIdentifier } from "./paths.js";
import { parseGitSnapshot } from "./git.js";
import { parseSessionArchive } from "./session.js";
import { writePrivateFile } from "./storage.js";

/** Downloading a validated private copy never applies files or switches sessions. */
export async function cachedResultArtifact(
  directory: string,
  kind: "git" | "session",
  id: string,
  download: () => Promise<Buffer>,
): Promise<Buffer> {
  validateIdentifier(id);
  const path = join(directory, `${kind}-${id}`);
  const validate = (raw: Buffer): Buffer => {
    if (kind === "git") parseGitSnapshot(raw.toString("utf8"));
    else parseSessionArchive(raw.toString("utf8"));
    return raw;
  };
  try { return validate(await readFile(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const raw = validate(await download());
  await writePrivateFile(path, raw);
  return raw;
}
