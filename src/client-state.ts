import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Locale, TaskStatus } from "./protocol.js";

export interface CloudConnectionState {
  baseUrl: string;
  workerId: string;
  fingerprint: string;
  token: string;
  pairedAt: string;
}

export interface CloudTaskState {
  taskId: string;
  workerId: string;
  baseUrl: string;
  fingerprint: string;
  projectId: string;
  sessionId: string;
  baseLeafId: string | null;
  lastEntryId: string | null;
  entriesSha256: string;
  cursor: number;
  status: TaskStatus;
  prompt: string;
  artifactId?: string;
  sessionArtifactId?: string;
  updatedAt: string;
}

export interface CloudClientState {
  locale?: Locale;
  connections: CloudConnectionState[];
  activeWorkerId?: string;
  tasks?: CloudTaskState[];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isConnection(value: unknown): value is CloudConnectionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ["baseUrl", "workerId", "fingerprint", "token", "pairedAt"].every(
    (key) => isString(item[key]),
  );
}

function isTask(value: unknown): value is CloudTaskState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    [
      "taskId",
      "workerId",
      "baseUrl",
      "fingerprint",
      "projectId",
      "sessionId",
      "entriesSha256",
      "prompt",
      "updatedAt",
    ].every((key) => isString(item[key])) &&
    (item.baseLeafId === null || isString(item.baseLeafId)) &&
    (item.lastEntryId === null || isString(item.lastEntryId)) &&
    typeof item.cursor === "number" &&
    Number.isInteger(item.cursor) &&
    item.cursor >= 0 &&
    (item.artifactId === undefined || isString(item.artifactId)) &&
    (item.sessionArtifactId === undefined || isString(item.sessionArtifactId)) &&
    ["queued", "running", "completed", "failed", "aborted"].includes(
      String(item.status),
    )
  );
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
    const connections = value.connections.filter(isConnection);
    const tasks = Array.isArray(value.tasks)
      ? value.tasks.filter(isTask)
      : [];
    const result: CloudClientState = {
      connections,
      ...(tasks.length > 0 ? { tasks } : {}),
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
