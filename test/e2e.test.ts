import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { CloudConnection } from "../src/client-network.js";
import { sha256 } from "../src/environment.js";
import {
  createWorkspaceArchive,
  parseGitSnapshot,
  serializeWorkspaceArchive,
} from "../src/git.js";
import type { ProtocolFrame, TaskSpec } from "../src/protocol.js";
import { defaultWorkerConfig, saveWorkerConfig } from "../src/worker/config.js";
import { createPairing } from "../src/worker/pairing.js";
import { startWorkerServer } from "../src/worker/server.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";

const run = promisify(execFile);

test("pairs, uploads a repository, runs RPC, and returns Git results", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-cloud-e2e-source-"));
  await run("git", ["init", "-q"], { cwd: source });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: source });
  await run("git", ["config", "user.name", "Pi Cloud Test"], { cwd: source });
  await writeFile(join(source, "file.txt"), "before\n");
  await run("git", ["add", "file.txt"], { cwd: source });
  await run("git", ["commit", "-qm", "initial"], { cwd: source });
  const archive = await createWorkspaceArchive(source);
  const workspaceData = Buffer.from(serializeWorkspaceArchive(archive));

  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-e2e-worker-"));
  await saveWorkerConfig({ ...defaultWorkerConfig(dataDir), publicIp: "127.0.0.1", runner: "host" });
  const state = await loadWorkerState(dataDir);
  const pairing = createPairing(state);
  await saveWorkerState(dataDir, state);
  const worker = await startWorkerServer({
    dataDir,
    publicIp: "127.0.0.1",
    piVersion: "0.84.2",
    nodeVersion: process.version,
    gitVersion: "git",
    port: 0,
    rpcCommand: process.execPath,
    rpcArgs: [
      "-e",
      "let done=false;process.stdin.on('data',()=>{if(done)return;done=true;require('node:fs').writeFileSync('remote.txt','done\\n');console.log(JSON.stringify({type:'agent_settled'}))})",
      "--",
    ],
  });
  try {
    const currentState = await loadWorkerState(dataDir);
    assert.ok(currentState.certificateFingerprint);
    const connection = new CloudConnection(worker.url, currentState.certificateFingerprint);
    await connection.pair(pairing.code);
    await connection.upload("workspace", workspaceData, "application/json");

    const task: TaskSpec = {
      taskId: "e2e-task",
      projectId: "project",
      prompt: "create remote.txt",
      runner: "host",
      environment: { piVersion: "0.84.2", nodeVersion: "24", platform: "linux", packages: [], resources: [], providers: [], secretVersions: [], warnings: [] },
      git: archive.snapshot.baseline,
      session: { sessionId: "new", baseLeafId: null, lastEntryId: null, entriesSha256: "empty" },
      artifacts: [{ id: "workspace", kind: "workspace", size: workspaceData.byteLength, sha256: sha256(workspaceData), contentType: "application/json" }],
      secretIds: [],
    };
    const frames: ProtocolFrame[] = [];
    const socket = await connection.openEvents((frame) => frames.push(frame));
    connection.send(socket, { type: "task_create", task });
    for (let attempt = 0; attempt < 120 && worker.tasks.get(task.taskId)?.status !== "completed"; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const record = worker.tasks.get(task.taskId);
    assert.equal(record?.status, "completed");
    const statusEvent = record.events.findLast((event) => event.payload.status === "completed");
    const resultArtifactId = String(statusEvent?.payload.resultArtifactId ?? "");
    assert.ok(resultArtifactId);
    const result = parseGitSnapshot((await connection.download(resultArtifactId)).toString("utf8"));
    assert.deepEqual(result.files.map((file) => file.path), ["remote.txt"]);
    assert.equal(frames.some((frame) => frame.type === "task_accepted"), true);
    socket.terminate();
  } finally {
    await worker.close();
  }
});
