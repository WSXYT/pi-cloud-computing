import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";

const execFileAsync = promisify(execFile);
const systemTool = (name: string): string => join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", name);
let currentSid: Promise<string> | undefined;
async function windowsSid(): Promise<string> {
  currentSid ??= execFileAsync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true }).then(({ stdout }) => {
    const sid = stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
    if (!sid) throw new Error("Could not identify the current Windows account for private storage");
    return sid;
  });
  return currentSid;
}

async function secureWindowsPath(path: string, directory = false): Promise<void> {
  if (process.platform !== "win32") return;
  const sid = await windowsSid();
  await execFileAsync(systemTool("icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:${directory ? "(OI)(CI)F" : "F"}`, ...(directory ? ["/T"] : [])], { windowsHide: true });
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await secureWindowsPath(path, true);
}

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
    if (process.platform === "win32") {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await secureWindowsPath(temporary);
        await handle.writeFile(data);
        await handle.sync();
      } finally { await handle.close(); }
    } else {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx", flush: true });
    }
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
