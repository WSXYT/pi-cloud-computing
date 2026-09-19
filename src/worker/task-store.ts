import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateIdentifier } from "../paths.js";
import { writePrivateJson } from "../storage.js";
import type { TaskEvent } from "../protocol.js";
import type { TaskRecord } from "./tasks.js";

const savedCursors = new Map<string, number>();

async function readJournal(path: string): Promise<TaskEvent[] | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskEvent);
    let cursor = 0;
    for (const event of events) {
      if (
        !Number.isSafeInteger(event.cursor) ||
        event.cursor <= cursor ||
        !event.payload ||
        typeof event.payload !== "object"
      )
        throw new Error("invalid event");
      cursor = event.cursor;
    }
    return events;
  } catch {
    throw new Error(
      `invalid task event journal: ${path}; original data was preserved`,
    );
  }
}

export async function loadTaskRecords(dataDir: string): Promise<TaskRecord[]> {
  let text: string;
  try {
    text = await readFile(join(dataDir, "tasks.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let records: TaskRecord[];
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!Array.isArray(value)) throw new Error("invalid task store");
    records = value as TaskRecord[];
    for (const record of records) {
      validateIdentifier(record?.task?.taskId);
      if (
        !["queued", "running", "completed", "failed", "aborted"].includes(
          record.status,
        ) ||
        !Array.isArray(record.events) ||
        !Array.isArray(record.inputs) ||
        !Number.isSafeInteger(record.cursor) ||
        record.cursor < 0
      )
        throw new Error("invalid task record");
    }
  } catch {
    throw new Error(
      "invalid tasks.json; original task recovery data was preserved",
    );
  }
  for (const record of records) {
    const path = join(dataDir, "events", `${record.task.taskId}.jsonl`);
    const journal = await readJournal(path);
    if (journal) {
      if (journal.some((event) => event.taskId !== record.task.taskId))
        throw new Error("task journal identity mismatch");
      record.events = journal;
      for (const event of journal.filter(
        (event) => event.cursor > record.cursor,
      )) {
        if (
          event.kind === "status" &&
          ["completed", "failed", "aborted"].includes(
            String(event.payload.status),
          )
        ) {
          const status = event.payload.status as
            | "completed"
            | "failed"
            | "aborted";
          record.status = status;
          record.result = {
            ...event.payload,
            taskId: record.task.taskId,
            status,
          };
        }
      }
      record.cursor = Math.max(record.cursor, journal.at(-1)?.cursor ?? 0);
    }
    savedCursors.set(path, journal?.at(-1)?.cursor ?? 0);
  }
  return records;
}

export async function saveTaskRecords(
  dataDir: string,
  records: TaskRecord[],
): Promise<void> {
  await mkdir(join(dataDir, "events"), { recursive: true, mode: 0o700 });
  for (const record of records) {
    validateIdentifier(record.task.taskId);
    const path = join(dataDir, "events", `${record.task.taskId}.jsonl`);
    const cursor =
      savedCursors.get(path) ?? (await readJournal(path))?.at(-1)?.cursor ?? 0;
    const events = record.events.filter((event) => event.cursor > cursor);
    if (!events.length) continue;
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    savedCursors.set(path, events.at(-1)!.cursor);
  }
  // Append event bytes once; don't rewrite the entire transcript on every text delta.
  await writePrivateJson(
    join(dataDir, "tasks.json"),
    records.map((record) => ({ ...record, events: [] })),
  );
}
