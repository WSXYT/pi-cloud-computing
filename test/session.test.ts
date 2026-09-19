import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/environment.js";
import {
  extractRemoteTail,
  exportSessionBranch,
  mergeSessionTail,
  parseSessionArchive,
  serializeSessionArchive,
  type SessionArchive,
} from "../src/session.js";
import type { SessionCursor } from "../src/protocol.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const header = (id: string) => ({
  type: "session" as const,
  version: 3,
  id,
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/workspace",
});
const entry = (id: string, parentId: string | null, customType = "test") => ({
  type: "custom" as const,
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  customType,
  data: { id },
});

function archive(
  id: string,
  entries: SessionEntry[],
): SessionArchive {
  const body = entries.map((item) => JSON.stringify(item)).join("\n");
  return {
    header: header(id),
    entries,
    leafId: entries.at(-1)?.id ?? null,
    entriesSha256: sha256(body),
  };
}

test("exports and parses a native session archive", () => {
  const original = archive("s1", [entry("e1", null)]);
  assert.deepEqual(
    parseSessionArchive(serializeSessionArchive(original)),
    original,
  );
});

test("exports only durable cloud session entries", () => {
  const entries = [
    entry("e1", null),
    entry("live", "e1", "pi-cloud-live"),
    entry("task", "live", "pi-cloud-task"),
    entry("e2", "task"),
  ];
  const archive = exportSessionBranch({
    getHeader: () => header("s1"),
    getBranch: () => entries,
    getLeafId: () => "e2",
  });
  assert.deepEqual(
    archive.entries.map((item) => item.id),
    ["e1", "e2"],
  );
  assert.equal(archive.entries[1]?.parentId, "e1");
  assert.equal(archive.leafId, "e2");
});

test("merges a linear remote tail and drops live display entries", () => {
  const source = archive("s1", [entry("e1", null)]);
  const remote = archive("s1", [
    entry("e1", null),
    entry("e2", "e1"),
    entry("live", "e2", "pi-cloud-live"),
  ]);
  const cursor: SessionCursor = {
    sessionId: "s1",
    baseLeafId: "e1",
    lastEntryId: "e1",
    entriesSha256: source.entriesSha256,
  };
  assert.deepEqual(
    extractRemoteTail(remote, cursor).map((item) => item.id),
    ["e2"],
  );
  const merged = mergeSessionTail(source, remote, cursor);
  assert.deepEqual(
    merged.entries.map((item) => item.id),
    ["e1", "e2"],
  );
  assert.equal(merged.header.parentSession, "s1");
});

test("refuses to merge after local session changes", () => {
  const source = archive("s1", [entry("e1", null)]);
  const changed = archive("s1", [entry("e1", null), entry("local", "e1")]);
  const remote = archive("s1", [entry("e1", null), entry("e2", "e1")]);
  const cursor: SessionCursor = {
    sessionId: "s1",
    baseLeafId: "e1",
    lastEntryId: "e1",
    entriesSha256: source.entriesSha256,
  };
  assert.throws(
    () => mergeSessionTail(changed, remote, cursor),
    /local session changed/,
  );
});

test("unchanged resume settings do not invalidate a handoff, but real setting changes do", () => {
  const thinking = (id: string, parentId: string | null, level: "off" | "high") => ({ type: "thinking_level_change" as const, id, parentId, timestamp: header("s1").timestamp, thinkingLevel: level });
  const model = (id: string, parentId: string) => ({ type: "model_change" as const, id, parentId, timestamp: header("s1").timestamp, provider: "test", modelId: "fixture" });
  const original = [thinking("thinking", null, "off"), model("model", "thinking"), entry("base", "model")];
  const exported = (entries: SessionEntry[]) => exportSessionBranch({ getHeader: () => header("s1"), getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null });
  const source = exported(original);
  const resumed = exported([...original, entry("live", "base", "pi-cloud-live"), thinking("resume", "live", "off"), model("same-model", "resume")]);
  assert.deepEqual(resumed, source);
  const cursor = { sessionId: "s1", baseLeafId: "base", lastEntryId: "base", entriesSha256: source.entriesSha256 };
  const remote = archive("s1", [...original, thinking("remote-resume", "base", "off"), entry("answer", "remote-resume")]);
  assert.equal(mergeSessionTail(resumed, remote, cursor).entries.at(-1)?.parentId, "base");
  assert.throws(() => mergeSessionTail(exported([...original, thinking("changed", "base", "high")]), remote, cursor), /local session changed/);
});
