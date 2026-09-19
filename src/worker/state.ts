import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { withPrivateFileLock, writePrivateJson } from "../storage.js";

export interface WorkerToken {
  id: string;
  hash: string;
  createdAt: string;
  revokedAt?: string;
}
export interface WorkerState {
  workerId: string;
  certificateFingerprint?: string;
  pairingCodeHash?: string;
  pairingExpiresAt?: string;
  tokens: WorkerToken[];
  activeTaskId?: string;
}
export function newWorkerState(): WorkerState {
  return { workerId: randomUUID(), tokens: [] };
}

export async function loadWorkerState(dataDir: string): Promise<WorkerState> {
  const path = join(dataDir, "state.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = newWorkerState();
    try {
      await writePrivateJson(path, state, true);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return loadWorkerState(dataDir);
    }
  }
  try {
    const state = JSON.parse(text.replace(/^\uFEFF/, "")) as WorkerState;
    if (
      !state ||
      typeof state.workerId !== "string" ||
      !state.workerId ||
      !Array.isArray(state.tokens) ||
      state.tokens.some(
        (token) =>
          !token ||
          typeof token.id !== "string" ||
          typeof token.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(token.hash) ||
          (token.revokedAt !== undefined && typeof token.revokedAt !== "string") ||
          typeof token.createdAt !== "string",
      )
    )
      throw new Error("invalid state");
    return state;
  } catch {
    throw new Error(
      "invalid state.json; pairing and revocation data were preserved",
    );
  }
}

export async function saveWorkerState(
  dataDir: string,
  state: WorkerState,
): Promise<void> {
  await writePrivateJson(join(dataDir, "state.json"), state);
}

/** The service and CLI serialize administrative state changes across processes. */
export async function withWorkerStateLock<T>(
  dataDir: string,
  action: () => Promise<T>,
): Promise<T> {
  return withPrivateFileLock(join(dataDir, "state.json"), action);
}

export async function updateWorkerState<T>(dataDir: string, update: (state: WorkerState) => T | Promise<T>): Promise<T> {
  return withWorkerStateLock(dataDir, async () => {
    const state = await loadWorkerState(dataDir);
    const result = await update(state);
    await saveWorkerState(dataDir, state);
    return result;
  });
}
