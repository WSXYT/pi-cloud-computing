import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CloudQueue } from "./client-queue.js";
import type { TransferProgress } from "./client-network.js";
import type { GitBaseline, Locale, SessionCursor, TaskEvent, TaskInput, TaskSpec, TaskStatus } from "./protocol.js";
import { withPrivateFileLock, writePrivateJson } from "./storage.js";

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
  sessionPath?: string;
  submittedSessionPath?: string;
  remoteSession?: SessionCursor;
  git?: GitBaseline;
  appliedGit?: GitBaseline;
  mergedSessionId?: string;
  spec?: TaskSpec;
  readyToSubmit?: boolean;
  accepted?: boolean;
  finalizing?: boolean;
  pendingAbort?: boolean;
  pendingInputs?: TaskInput[];
  error?: string;
  requestFailure?: TransferProgress & { code: string; artifactKind?: string; serverCause?: string };
  outcomeUnknown?: boolean;
  nativeTranscript?: TaskEvent[];
  cloudQueue?: CloudQueue;
  dequeueRequest?: { id: string; backup: CloudQueue };
  dequeuedDraft?: string;
  stopQueue?: CloudQueue;
}

export const CLOUD_SHORTCUTS = ["f6", "f7", "f8", "f9", "f10", "f11", "f12", "disabled"] as const;

export interface CloudClientState {
  locale?: Locale;
  shortcut?: typeof CLOUD_SHORTCUTS[number];
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
    (item.sessionArtifactId === undefined ||
      isString(item.sessionArtifactId)) &&
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
    const parsed: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid client state");
    const value = parsed as Partial<CloudClientState>;
    if (!Array.isArray(value.connections))
      throw new Error("invalid client state");
    const connections = value.connections.filter(isConnection);
    const tasks = Array.isArray(value.tasks) ? value.tasks.filter(isTask) : [];
    const result: CloudClientState = {
      connections,
      ...(tasks.length > 0 ? { tasks } : {}),
    };
    if (value.shortcut && CLOUD_SHORTCUTS.includes(value.shortcut)) result.shortcut = value.shortcut;
    if (value.locale === "en" || value.locale === "zh-CN")
      result.locale = value.locale;
    if (typeof value.activeWorkerId === "string")
      result.activeWorkerId = value.activeWorkerId;
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connections: [] };
    throw new Error(`Could not read Pi Cloud state; original data was preserved: ${path}`, { cause: error });
  }
}

export async function saveClientState(
  state: CloudClientState,
  path = clientStatePath(),
): Promise<void> {
  await writePrivateJson(path, state);
}

export async function updateClientState(update: (state: CloudClientState) => CloudClientState, path = clientStatePath()): Promise<CloudClientState> {
  return withPrivateFileLock(path, async () => {
    const state = update(await loadClientState(path));
    await saveClientState(state, path);
    return state;
  });
}
