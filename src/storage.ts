import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";

/** The same lease settings are shared by the client, Worker and administrative CLI. */
export async function withPrivateFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path, {
    realpath: false, stale: 10_000, update: 2_000,
    retries: { retries: 150, minTimeout: 100, maxTimeout: 100, factor: 1 },
  });
  try { return await action(); }
  finally { await release(); }
}


/** Atomic private state; a failed write never truncates the previous file. */
export async function writePrivateFile(
  path: string,
  data: string | Uint8Array,
  exclusive = false,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    if (exclusive) await link(temporary, path);
    else {
      // Windows readers/antivirus can briefly deny replacement. Never unlink the old state to work around it.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== "win32" || attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await delay(25 * (attempt + 1));
        }
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writePrivateJson(path: string, value: unknown, exclusive = false): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value)}\n`, exclusive);
}
