import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/client.js";
import { CloudConnection } from "../src/client-network.js";
import { loadClientState, saveClientState, type CloudTaskState } from "../src/client-state.js";
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
      registerEntryRenderer() {},
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
      sessionManager: { getSessionId: () => "recover-session", getEntries: () => [] },
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

test("retry uses the failed task's Worker without switching the default or losing task history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-retry-"));
  const statePath = join(root, "state.json");
  const sessionPath = join(root, "session.jsonl");
  const previous = process.env.PI_CLOUD_CLIENT_STATE;
  process.env.PI_CLOUD_CLIENT_STATE = statePath;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
    else process.env.PI_CLOUD_CLIENT_STATE = previous;
    await rm(root, { recursive: true, force: true });
  });
  const failed: CloudTaskState = {
    taskId: "failed-upload", workerId: "original", baseUrl: "https://original.invalid", fingerprint: "aa".repeat(32),
    projectId: root, sessionId: "local-session", baseLeafId: null, lastEntryId: null, entriesSha256: "empty",
    cursor: 0, status: "failed", prompt: "original prompt", updatedAt: new Date().toISOString(),
  };
  await saveClientState({ locale: "en", activeWorkerId: "different", tasks: [failed], connections: ["original", "different"].map((id) => ({
    workerId: id, baseUrl: `https://${id}.invalid`, fingerprint: "aa".repeat(32), token: "fixture-token", pairedAt: new Date().toISOString(),
  })) }, statePath);
  await writeFile(sessionPath, "fixture");
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  let start: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  const notifications: string[] = [];
  const fake = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, options.handler); },
    registerEntryRenderer() {},
    on(name: string, handler: typeof start) { if (name === "session_start") start = handler; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "local-session", getSessionName: () => "existing", getSessionFile: () => sessionPath },
    ui: { setStatus() {}, setWidget() {}, notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionCommandContext;
  const contacted: string[] = [];
  t.mock.method(CloudConnection.prototype, "workerInfo", async function (this: CloudConnection) {
    contacted.push(this.baseUrl);
    throw new Error("stop before preflight");
  });
  await extension(fake);
  await start!({}, ctx);
  await commands.get("cloud-retry")!("", ctx);
  assert.deepEqual(contacted, ["https://original.invalid"]);
  assert.ok(notifications.some((text) => text.includes("stop before preflight")));
  const saved = await loadClientState(statePath);
  assert.equal(saved.activeWorkerId, "different");
  assert.deepEqual(saved.tasks, [failed], "a failed retry must retain the original task");
});

test("registers the cloud command surface", async () => {
  const commands: string[] = [];
  const fake = {
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
    registerEntryRenderer() {},
  } as unknown as ExtensionAPI;
  await extension(fake);
  assert.deepEqual(commands, [
    "cloud-pair",
    "cloud-unpair",
    "cloud-abort",
    "cloud-submit",
    "cloud-retry",
    "cloud-reconnect",
    "cloud-apply",
    "cloud-merge",
    "cloud-local",
    "cloud-tasks",
    "cloud-inputs",
    "cloud-secrets",
    "cloud-worker",
    "cloud-status",
    "cloud-help",
    "cloud-language",
    "cloud-sponsor",
    "cloud",
  ]);
});
