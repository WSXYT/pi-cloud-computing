import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";

import { sha256 } from "./environment.js";
import type { SessionCursor } from "./protocol.js";

export interface SessionReader {
  getHeader(): SessionHeader | null;
  getBranch(fromId?: string): SessionEntry[];
  getLeafId(): string | null;
}

export interface SessionArchive {
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
  entriesSha256: string;
}

export interface MergedSession {
  header: SessionHeader;
  entries: SessionEntry[];
  leafId: string | null;
  sourceSessionId: string;
  remoteSessionId: string;
}

function assertEntry(entry: unknown): asserts entry is SessionEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    throw new Error("session entry must be an object");
  const value = entry as Record<string, unknown>;
  if (
    typeof value.type !== "string" ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string"
  ) {
    throw new Error("session entry has invalid identity fields");
  }
  if (value.parentId !== null && typeof value.parentId !== "string")
    throw new Error("session entry has invalid parentId");
}

function assertHeader(value: unknown): asserts value is SessionHeader {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("session header must be an object");
  const header = value as Record<string, unknown>;
  if (
    header.type !== "session" ||
    typeof header.id !== "string" ||
    typeof header.timestamp !== "string" ||
    typeof header.cwd !== "string"
  ) {
    throw new Error("session header is invalid");
  }
  if (header.version !== undefined && typeof header.version !== "number")
    throw new Error("session header version is invalid");
}

function entriesJson(entries: SessionEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

export function exportSessionBranch(reader: SessionReader): SessionArchive {
  const header = reader.getHeader();
  if (!header) throw new Error("session has no header");
  const entries = durableEntries(reader.getBranch());
  validateSessionEntries(entries);
  return {
    header,
    entries,
    leafId: entries.at(-1)?.id ?? null,
    entriesSha256: sha256(entriesJson(entries)),
  };
}

export function validateSessionEntries(entries: SessionEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    assertEntry(entry);
    if (ids.has(entry.id))
      throw new Error(`duplicate session entry: ${entry.id}`);
    if (entry.parentId !== null && !ids.has(entry.parentId))
      throw new Error(`orphan session entry: ${entry.id}`);
    ids.add(entry.id);
  }
}

export function serializeSessionArchive(archive: SessionArchive): string {
  assertHeader(archive.header);
  validateSessionEntries(archive.entries);
  return `${JSON.stringify(archive.header)}\n${entriesJson(archive.entries)}\n`;
}

export function parseSessionArchive(value: string): SessionArchive {
  const entries = value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error("session archive contains invalid JSON");
      }
    });
  const header = entries.shift();
  assertHeader(header);
  const sessionEntries: SessionEntry[] = [];
  for (const entry of entries) {
    assertEntry(entry);
    sessionEntries.push(entry);
  }
  validateSessionEntries(sessionEntries);
  return {
    header,
    entries: sessionEntries,
    leafId: sessionEntries.at(-1)?.id ?? null,
    entriesSha256: sha256(entriesJson(sessionEntries)),
  };
}

export function isTemporaryCloudEntry(entry: SessionEntry): boolean {
  return (
    (entry.type === "custom" || entry.type === "custom_message") &&
    (entry.customType === "pi-cloud-live" ||
      entry.customType === "pi-cloud-task")
  );
}

function durableEntries(entries: SessionEntry[]): SessionEntry[] {
  const durable: SessionEntry[] = [];
  const nearestDurable = new Map<string, string | null>();
  for (const entry of entries) {
    if (isTemporaryCloudEntry(entry)) {
      nearestDurable.set(entry.id, durable.at(-1)?.id ?? null);
      continue;
    }
    let parentId = entry.parentId;
    while (parentId && nearestDurable.has(parentId))
      parentId = nearestDurable.get(parentId) ?? null;
    const normalized =
      parentId === entry.parentId ? entry : { ...entry, parentId };
    durable.push(normalized);
  }
  return durable;
}

export function extractRemoteTail(
  remote: SessionArchive,
  cursor: SessionCursor,
): SessionEntry[] {
  if (remote.header.id !== cursor.sessionId)
    throw new Error("remote session id does not match cursor");
  if (cursor.entriesSha256 === remote.entriesSha256) return [];
  const entries = durableEntries(remote.entries);
  const durableBaseIndex =
    cursor.lastEntryId === null
      ? -1
      : entries.findIndex((entry) => entry.id === cursor.lastEntryId);
  if (cursor.lastEntryId !== null && durableBaseIndex < 0)
    throw new Error("remote session cursor is missing");
  const tail = entries.slice(durableBaseIndex + 1);
  if (
    tail[0] &&
    tail[0].parentId !== cursor.baseLeafId &&
    cursor.lastEntryId !== null
  ) {
    throw new Error(
      "remote session tail does not continue from the submitted leaf",
    );
  }
  return tail;
}

export function mergeSessionTail(
  source: SessionArchive,
  remote: SessionArchive,
  cursor: SessionCursor,
): MergedSession {
  if (source.header.id !== cursor.sessionId)
    throw new Error("source session id does not match cursor");
  if (source.entriesSha256 !== cursor.entriesSha256)
    throw new Error("local session changed since submission");
  const tail = extractRemoteTail(remote, cursor);
  const existingIds = new Set(source.entries.map((entry) => entry.id));
  for (const entry of tail) {
    if (existingIds.has(entry.id))
      throw new Error(`remote entry collides with local entry: ${entry.id}`);
    existingIds.add(entry.id);
  }
  const entries = [...source.entries, ...tail];
  validateSessionEntries(entries);
  return {
    header: {
      ...source.header,
      id: randomUUID(),
      parentSession: source.header.id,
    },
    entries,
    leafId: entries.at(-1)?.id ?? source.leafId,
    sourceSessionId: source.header.id,
    remoteSessionId: remote.header.id,
  };
}

export async function writeMergedSession(
  path: string,
  merged: MergedSession,
): Promise<void> {
  const archive: SessionArchive = {
    header: merged.header,
    entries: merged.entries,
    leafId: merged.leafId,
    entriesSha256: sha256(entriesJson(merged.entries)),
  };
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, serializeSessionArchive(archive), {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, path);
}
