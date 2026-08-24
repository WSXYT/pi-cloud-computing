import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Locale } from "./protocol.js";

export interface CloudConnectionState {
  baseUrl: string;
  workerId: string;
  fingerprint: string;
  token: string;
  pairedAt: string;
}

export interface CloudClientState {
  locale?: Locale;
  connections: CloudConnectionState[];
  activeWorkerId?: string;
}

export function clientStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.PI_CLOUD_CLIENT_STATE ??
    join(
      env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      "pi-cloud.json",
    )
  );
}

export async function loadClientState(
  path = clientStatePath(),
): Promise<CloudClientState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid client state");
    const value = parsed as Partial<CloudClientState>;
    if (!Array.isArray(value.connections))
      throw new Error("invalid client state");
    const result: CloudClientState = {
      connections: value.connections as CloudConnectionState[],
    };
    if (value.locale === "en" || value.locale === "zh-CN")
      result.locale = value.locale;
    if (typeof value.activeWorkerId === "string")
      result.activeWorkerId = value.activeWorkerId;
    return result;
  } catch {
    return { connections: [] };
  }
}

export async function saveClientState(
  state: CloudClientState,
  path = clientStatePath(),
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
