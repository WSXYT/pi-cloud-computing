import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { writePrivateFile } from "../storage.js";

export interface SystemdUnitOptions {
  executable?: string;
  cliPath?: string;
  dataDir: string;
  docker?: boolean;
}

function systemdQuote(value: string, executable = false): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("invalid systemd value");
  const escaped = value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${executable ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
  const executable = options.executable ?? process.execPath;
  const cliPath = options.cliPath ?? process.argv[1] ?? "pi-cloud";
  const user = userInfo();
  const account = user.uid >= 0 ? String(user.uid) : user.username;
  if (!/^[A-Za-z0-9_.-]+$/.test(account)) throw new Error("invalid systemd service account");
  return [
    "[Unit]", "Description=Pi Cloud Worker", "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", "Type=simple", `User=${account}`,
    ...(options.docker ? ["SupplementaryGroups=docker"] : []),
    `ExecStart=${systemdQuote(executable, true)} ${systemdQuote(cliPath, true)} worker serve`,
    `Environment=${systemdQuote(`PI_CLOUD_DATA_DIR=${options.dataDir}`)}`,
    `Environment=${systemdQuote(`HOME=${homedir()}`)}`,
    `Environment=${systemdQuote(`PATH=${dirname(executable)}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)}`,
    "Restart=on-failure", "RestartSec=3", "UMask=0077", "KillMode=control-group", "TimeoutStopSec=30",
    "NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=read-only",
    `ReadWritePaths=${systemdQuote(options.dataDir)}`, "", "[Install]", "WantedBy=multi-user.target", "",
  ].join("\n");
}

export async function writeSystemdUnit(
  dataDir: string,
  options: Omit<SystemdUnitOptions, "dataDir"> = {},
): Promise<string> {
  const path = join(dataDir, "pi-cloud-worker.service");
  await writePrivateFile(path, renderSystemdUnit({ ...options, dataDir }));
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
