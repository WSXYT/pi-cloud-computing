import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TaskRecord } from "./tasks.js";

export async function loadTaskRecords(dataDir: string): Promise<TaskRecord[]> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(dataDir, "tasks.json"), "utf8"),
    );
    if (!Array.isArray(value)) throw new Error("invalid task store");
    return value as TaskRecord[];
  } catch {
    return [];
  }
}

export async function saveTaskRecords(
  dataDir: string,
  records: TaskRecord[],
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const pending = join(dataDir, "tasks.json.tmp");
  await writeFile(pending, `${JSON.stringify(records, null, 2)}\n`, {
    mode: 0o600,
  });
  const { rename } = await import("node:fs/promises");
  await rename(pending, join(dataDir, "tasks.json"));
}
