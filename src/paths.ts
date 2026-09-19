import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Portable archive paths never name Git internals, drive paths, or parent directories. */
export function validateRelativePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    /[\\:\x00-\x1f]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          /[. ]$/.test(part),
      )
  ) {
    throw new Error(`unsafe archive path: ${String(value)}`);
  }
}

/** Lexical containment alone does not prevent a write through a symlink/junction. */
export async function safeFilePath(
  root: string,
  path: string,
): Promise<string> {
  validateRelativePath(path);
  let current = await realpath(root);
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`symlink archive path is not supported: ${path}`);
      if (index < parts.length - 1 && !info.isDirectory())
        throw new Error(`archive parent is not a directory: ${path}`);
      if (index === parts.length - 1 && !info.isFile())
        throw new Error(`archive target is not a regular file: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

export function validateIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)
  )
    throw new Error("invalid task/artifact identifier");
}

export function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string")
    throw new Error("archive content must be base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("invalid base64 archive content");
  return bytes;
}
