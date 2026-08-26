import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createWorkspaceArchive, parseGitSnapshot, serializeWorkspaceArchive } from "../src/git.js";
import type { TaskSpec } from "../src/protocol.js";
import { ArtifactStore } from "../src/worker/artifacts.js";
import {
  cleanupPreparedTask,
  collectTaskResults,
  prepareTask,
} from "../src/worker/execution.js";
import { SecretStore } from "../src/worker/secrets.js";
import type { TaskRecord } from "../src/worker/tasks.js";

const run = promisify(execFile);

test("prepares an uploaded repository and returns its remote changes", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-cloud-execution-source-"));
  await run("git", ["init", "-q"], { cwd: source });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: source });
  await run("git", ["config", "user.name", "Pi Cloud Test"], { cwd: source });
  await writeFile(join(source, "file.txt"), "before\n");
  await run("git", ["add", "file.txt"], { cwd: source });
  await run("git", ["commit", "-qm", "initial"], { cwd: source });
  const archive = await createWorkspaceArchive(source);
  const data = Buffer.from(serializeWorkspaceArchive(archive));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-execution-worker-"));
  const store = await ArtifactStore.open(dataDir);
  const secrets = await SecretStore.open(dataDir);
  const descriptor = await store.put("workspace", data, "application/json");
  await secrets.put("pi-auth", 1, "{\"provider\":\"secret\"}");
  const task = {
    taskId: "task-1",
    projectId: "project",
    prompt: "change file",
    runner: "host",
    environment: { piVersion: "0.84.2", nodeVersion: "24", platform: "linux", packages: [], resources: [], providers: [], secretVersions: [], warnings: [] },
    git: archive.snapshot.baseline,
    session: { sessionId: "new", baseLeafId: null, lastEntryId: null, entriesSha256: "empty" },
    artifacts: [{ ...descriptor, kind: "workspace" }],
    secretIds: ["pi-auth"],
  } satisfies TaskSpec;
  const record: TaskRecord = { task, status: "running", cursor: 0, events: [], inputs: [] };
  const prepared = await prepareTask(dataDir, store, secrets, record);
  assert.equal((await readFile(join(prepared.workspace, "file.txt"), "utf8")).replaceAll("\r\n", "\n"), "before\n");
  assert.equal(await readFile(join(prepared.runtimeAgentDir ?? "", "auth.json"), "utf8"), "{\"provider\":\"secret\"}");
  await writeFile(join(prepared.workspace, "file.txt"), "after\n");
  const payload = await collectTaskResults(store, record, prepared);
  const result = parseGitSnapshot((await store.read(String(payload.resultArtifactId))).toString("utf8"));
  assert.deepEqual(result.files.map((file) => file.path), ["file.txt"]);
  await cleanupPreparedTask(prepared);
  await assert.rejects(() => readFile(join(prepared.runtimeAgentDir ?? "", "auth.json")));
});
