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
      registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {},
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
    registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {},
    on(name: string, handler: typeof start) { if (name === "session_start") start = handler; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "local-session", getSessionName: () => "existing", getSessionFile: () => sessionPath, getEntries: () => [] },
    ui: { setStatus() {}, setWidget() {}, confirm: async () => true, notify(message: string) { notifications.push(message); } },
  } as unknown as ExtensionCommandContext;
  const contacted: string[] = [];
  t.mock.method(CloudConnection.prototype, "workerInfo", async function (this: CloudConnection) {
    contacted.push(this.baseUrl);
    throw new Error("stop before preflight");
  });
  await extension(fake);
  const cleared: Array<[string, unknown]> = [];
  ctx.ui.setStatus = (key, value) => { cleared.push([key, value]); };
  ctx.ui.setWidget = (key, value) => { cleared.push([key, value]); };
  await start!({}, ctx);
  assert.ok(cleared.some(([key, value]) => key === "pi-cloud" && value === undefined));
  assert.equal(notifications.length, 0, "restoring a failed task must not repeat its error or pin a result widget");
  const rejectRetry = t.mock.method(ctx.ui, "confirm", async () => false);
  await commands.get("cloud-retry")!("", ctx);
  assert.deepEqual(contacted, [], "cancelled retries must never contact the Worker");
  rejectRetry.mock.restore();
  await commands.get("cloud-retry")!("", ctx);
  assert.deepEqual(contacted, ["https://original.invalid"]);
  assert.ok(notifications.some((text) => text.includes("stop before preflight")));
  const saved = await loadClientState(statePath);
  assert.equal(saved.activeWorkerId, "different");
  assert.deepEqual(saved.tasks, [failed], "a failed retry must retain the original task");
});

test("releases a task after connection rejection and lets local input continue", async (t) => {
  let shutdown = async () => {};
  let sessionShutdown: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-disconnect-"));
  const statePath = join(root, "state.json");
  const previous = process.env.PI_CLOUD_CLIENT_STATE;
  process.env.PI_CLOUD_CLIENT_STATE = statePath;
  t.after(async () => {
    await shutdown();
    if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
    else process.env.PI_CLOUD_CLIENT_STATE = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const task: CloudTaskState = {
    taskId: "running-task", workerId: "worker", baseUrl: "https://worker.invalid", fingerprint: "aa".repeat(32),
    projectId: root, sessionId: "session", baseLeafId: null, lastEntryId: null, entriesSha256: "empty",
    cursor: 0, status: "running", prompt: "run", updatedAt: new Date().toISOString(), accepted: true,
  };
  await saveClientState({ connections: [{ workerId: "worker", baseUrl: task.baseUrl, fingerprint: task.fingerprint, token: "token", pairedAt: new Date().toISOString() }], activeWorkerId: "worker", tasks: [task] }, statePath);
  let inputHandler: ((event: { text: string }, ctx: ExtensionContext) => Promise<{ action: string }>) | undefined;
  let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  const fake = {
    registerCommand() {}, registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {},
    on(name: string, handler: unknown) {
      if (name === "input") inputHandler = handler as typeof inputHandler;
      if (name === "session_start") sessionStart = handler as typeof sessionStart;
      if (name === "session_shutdown") sessionShutdown = handler as typeof sessionShutdown;
    },
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const ui = { setStatus() {}, setWidget() {}, notify(message: string) { notifications.push(message); } };
  t.mock.method(CloudConnection.prototype, "openEvents", async () => { throw new Error("CERTIFICATE_MISMATCH"); });
  await extension(fake);
  const ctx = { cwd: root, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "session", getEntries: () => [] }, ui } as unknown as ExtensionContext;
  shutdown = async () => { await sessionShutdown?.({}, ctx); };
  await sessionStart?.({}, ctx);
  const result = await inputHandler?.({ text: "local after disconnect" }, ctx);
  assert.deepEqual(result, { action: "continue" });
  assert.equal((await loadClientState(statePath)).tasks?.[0]?.pendingInputs, undefined, "local input must not enter the disconnected remote outbox");
  assert.equal(notifications.length, 1);
});

test("completed cloud results do not block an ordinary local input", async () => {
  const inputHandlers: Array<(event: { text: string }, ctx: ExtensionContext) => Promise<{ action: string }>> = [];
  const fake = {
    registerCommand() {}, registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {},
    on(name: string, handler: (event: { text: string }, ctx: ExtensionContext) => Promise<{ action: string }>) { if (name === "input") inputHandlers.push(handler); },
  } as unknown as ExtensionAPI;
  await extension(fake);
  assert.equal(inputHandlers.length, 1);
  const result = await inputHandlers[0]!({ text: "continue locally" }, { ui: { setEditorText() {} } } as unknown as ExtensionContext);
  assert.deepEqual(result, { action: "continue" });
});

test("registers F6 as the cloud submit shortcut", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-shortcut-"));
  const previous = process.env.PI_CLOUD_CLIENT_STATE;
  process.env.PI_CLOUD_CLIENT_STATE = join(root, "state.json");
  await saveClientState({ activeWorkerId: "worker", connections: [{ workerId: "worker", baseUrl: "https://example.invalid", fingerprint: "aa".repeat(32), token: "test-token", pairedAt: new Date().toISOString() }] });
  let shortcut: string | undefined;
  let shortcutHandler: ((ctx: ExtensionContext) => Promise<void>) | undefined;
  let editor = "run this in the cloud";
  let sent: string | undefined;
  const fake = {
    registerCommand() {}, registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {}, on() {},
    registerShortcut(key: string, options: { handler: (ctx: ExtensionContext) => Promise<void> }) { shortcut = key; shortcutHandler = options.handler; },
    sendUserMessage(message: string) { sent = message; },
  } as unknown as ExtensionAPI;
  try {
    await extension(fake);
    assert.equal(shortcut, "f6");
    const notifications: string[] = [];
    let idle = false;
    const ctx = { isIdle: () => idle, hasPendingMessages: () => false,
      ui: { getEditorText: () => editor, setEditorText: (value: string) => { editor = value; }, notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    await shortcutHandler?.(ctx);
    assert.equal(editor, "run this in the cloud", "busy local Pi must retain the draft");
    assert.equal(sent, undefined);
    assert.equal(notifications.length, 1);
    idle = true;
    await shortcutHandler?.(ctx);
    assert.equal(editor, "");
    assert.equal(sent, "/cloud-submit run this in the cloud");
    await saveClientState({ ...(await loadClientState()), shortcut: "f9" });
    await extension(fake);
    assert.equal(shortcut, "f9", "only the persisted cloud key is registered after reload");
    await saveClientState({ ...(await loadClientState()), shortcut: "disabled" });
    shortcut = undefined;
    await extension(fake);
    assert.equal(shortcut, undefined, "disabled means no cloud shortcut is registered");
  } finally {
    if (previous === undefined) delete process.env.PI_CLOUD_CLIENT_STATE;
    else process.env.PI_CLOUD_CLIENT_STATE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("registers the cloud command surface", async () => {
  const commands: string[] = [];
  const fake = {
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
    registerEntryRenderer() {}, registerMessageRenderer() {}, sendMessage() {},
  } as unknown as ExtensionAPI;
  await extension(fake);
  assert.deepEqual(commands, [
    "cloud-pair",
    "cloud-unpair",
    "cloud-abort",
    "cloud-cancel",
    "cloud-append",
    "cloud-submit",
    "cloud-retry",
    "cloud-shortcut",
    "cloud-reconnect",
    "cloud-apply",
    "cloud-merge",
    "cloud-receive",
    "cloud-local",
    "cloud-tasks",
    "cloud-dequeue",
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
