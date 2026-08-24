import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SystemdUnitOptions {
  executable?: string;
  cliPath?: string;
  dataDir: string;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
  const executable = options.executable ?? process.execPath;
  const cliPath = options.cliPath ?? process.argv[1] ?? "pi-cloud";
  return `[Unit]\nDescription=Pi Cloud Worker\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${executable} ${cliPath} worker serve\nRestart=on-failure\nRestartSec=3\nEnvironment=PI_CLOUD_DATA_DIR=${options.dataDir}\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export async function writeSystemdUnit(
  dataDir: string,
  options: Omit<SystemdUnitOptions, "dataDir"> = {},
): Promise<string> {
  const path = join(dataDir, "pi-cloud-worker.service");
  await writeFile(path, renderSystemdUnit({ ...options, dataDir }), {
    mode: 0o600,
  });
  return path;
}

export async function cleanupExpiredTasks(
  dataDir: string,
  retentionDays: number,
  now = Date.now(),
): Promise<string[]> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0)
    throw new Error("retentionDays must be positive");
  const root = join(dataDir, "tasks");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes("..")) continue;
    const path = join(root, entry.name);
    if ((await stat(path)).mtimeMs < cutoff) {
      await rm(path, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}
