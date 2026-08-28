import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/client.js";
import { CloudConnection } from "../src/client-network.js";
import { saveClientState } from "../src/client-state.js";
import type { TaskSpec } from "../src/protocol.js";
import { createPairing } from "../src/worker/pairing.js";
import { startWorkerServer } from "../src/worker/server.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";

test("restores a missed terminal event on session start", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-client-recovery-"));
  const statePath = join(dataDir, "pi-cloud.json");
  const previousStatePath = process.env.PI_CLOUD_CLIENT_STATE;
  process.env.PI_CLOUD_CLIENT_STATE = statePath;
  const worker = await startWorkerServer({
    dataDir,
    publicIp: "127.0.0.1",
    piVersion: "0.84.2",
    nodeVersion: process.version,
    gitVersion: "git",
    port: 0,
    enableExecution: false,
  });
  try {
    const workerState = await loadWorkerState(dataDir);
    const pairing = createPairing(workerState);
    await saveWorkerState(dataDir, workerState);
    const connection = new CloudConnection(
      worker.url,
      workerState.certificateFingerprint ?? "",
    );
    const paired = await connection.pair(pairing.code);
    const task: TaskSpec = {
      taskId: "recover-task",
      projectId: dataDir,
      prompt: "recover",
      runner: "host",
      environment: {
        piVersion: "0.84.2",
        nodeVersion: "24",
        platform: "linux",
        packages: [],
        resources: [],
        providers: [],
        secretVersions: [],
        warnings: [],
      },
      git: {
        repositoryHash: "repo",
        head: "head",
        indexHash: "index",
        worktreeHash: "tree",
        includedPaths: [],
      },
      session: {
        sessionId: "recover-session",
        baseLeafId: null,
        lastEntryId: null,
        entriesSha256: "entries",
      },
      artifacts: [],
      secretIds: [],
    };
    worker.tasks.create(task);
    worker.tasks.settle(task.taskId, "completed", {
      resultArtifactId: "recover-result",
    });
    await saveClientState(
      {
        connections: [
          {
            workerId: paired.workerId,
            baseUrl: worker.url,
            fingerprint: workerState.certificateFingerprint ?? "",
            token: paired.token,
            pairedAt: new Date().toISOString(),
          },
        ],
        activeWorkerId: paired.workerId,
        tasks: [
          {
            taskId: task.taskId,
            workerId: paired.workerId,
            baseUrl: worker.url,
            fingerprint: workerState.certificateFingerprint ?? "",
            projectId: dataDir,
            sessionId: task.session.sessionId,
            baseLeafId: null,
            lastEntryId: null,
            entriesSha256: task.session.entriesSha256,
            cursor: 1,
            status: "running",
            prompt: task.prompt,
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      statePath,
    );
    let sessionStart:
      | ((event: unknown, ctx: ExtensionContext) => Promise<void>)
      | undefined;
    const fake = {
      registerCommand() {},
      on(name: string, handler: typeof sessionStart) {
        if (name === "session_start") sessionStart = handler;
      },
      appendEntry() {},
    } as unknown as ExtensionAPI;
    await extension(fake);
    const ui = { setStatus() {}, setWidget() {}, notify() {} };
    await sessionStart?.({}, {
      cwd: dataDir,
      hasUI: false,
      sessionManager: { getSessionId: () => "recover-session" },
      ui,
    } as unknown as ExtensionContext);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const restored = JSON.parse(
        await (await import("node:fs/promises")).readFile(statePath, "utf8"),
      ) as { tasks?: Array<{ status: string; artifactId?: string }> };
      if (
        restored.tasks?.[0]?.status === "completed" &&
        restored.tasks[0].artifactId === "recover-result"
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("session_start did not persist the recovered terminal result");
  } finally {
    await worker.close();
    if (previousStatePath === undefined)
      delete process.env.PI_CLOUD_CLIENT_STATE;
    else process.env.PI_CLOUD_CLIENT_STATE = previousStatePath;
  }
});

test("registers the cloud command surface", async () => {
  const commands: string[] = [];
  const fake = {
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
  } as unknown as ExtensionAPI;
  await extension(fake);
  assert.deepEqual(commands, [
    "cloud-pair",
    "cloud-unpair",
    "cloud-abort",
    "cloud-submit",
    "cloud-reconnect",
    "cloud-apply",
    "cloud-merge",
    "cloud-status",
    "cloud-help",
    "cloud-language",
    "cloud-sponsor",
    "cloud",
  ]);
});
