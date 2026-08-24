import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  try {
    const value: unknown = JSON.parse(
      await readFile(join(dataDir, "state.json"), "utf8"),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("invalid state");
    const state = value as WorkerState;
    if (typeof state.workerId !== "string" || !Array.isArray(state.tokens))
      throw new Error("invalid state");
    return state;
  } catch {
    const state = newWorkerState();
    await saveWorkerState(dataDir, state);
    return state;
  }
}

export async function saveWorkerState(
  dataDir: string,
  state: WorkerState,
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
}
