import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { SessionManager, VERSION, type JsonAgentSessionEvent, type RpcCommand, type RpcExtensionUIRequest, type RpcExtensionUIResponse, type RpcResponse, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadClientState, saveClientState } from "../src/client-state.js";
import { sha256 } from "../src/environment.js";
import { snapshotDigest } from "../src/git.js";
import { parseSessionArchive } from "../src/session.js";
import { ArtifactStore } from "../src/worker/artifacts.js";
import { defaultWorkerConfig, saveWorkerConfig } from "../src/worker/config.js";
import { createPairing } from "../src/worker/pairing.js";
import { startWorkerServer } from "../src/worker/server.js";
import { updateWorkerState } from "../src/worker/state.js";

type NativeEvent = JsonAgentSessionEvent | RpcExtensionUIRequest | RpcResponse | { type: "extension_error"; error: string };
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extension = fileURLToPath(new URL("../../src/client.ts", import.meta.url));

// The public RpcClient has no dialog-response method; this test driver implements only JSONL and correlated replies.
class NativePi {
  readonly process: ChildProcessWithoutNullStreams;
  readonly events: NativeEvent[] = [];
  stderr = "";
  private readonly pending = new Map<string, (response: RpcResponse) => void>();

  constructor(cwd: string, agentDir: string, readonly answer: (request: RpcExtensionUIRequest) => RpcExtensionUIResponse | undefined, extraArgs: string[] = []) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all)$/i.test(key)));
    this.process = spawn(process.execPath, [cli, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", extension, ...extraArgs], {
      cwd, env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_CLOUD_CLIENT_STATE: join(agentDir, "pi-cloud.json") }, stdio: "pipe",
    });
    this.process.stderr.setEncoding("utf8").on("data", (data: string) => { this.stderr += data; });
    this.process.stdout.setEncoding("utf8");
    let buffer = "";
    this.process.stdout.on("data", (data: string) => {
      buffer += data;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          // SAFETY: this is the actual installed Pi's typed JSONL protocol; unexpected output fails the assertions below.
          const event = JSON.parse(line) as NativeEvent;
          this.events.push(event);
          if (event.type === "response" && event.id) this.pending.get(event.id)?.(event);
          if (event.type === "extension_ui_request") {
            const response = answer(event);
            if (response) this.process.stdin.write(`${JSON.stringify(response)}\n`);
          }
        } catch (error) { this.stderr += `\nJSONL/UI failure: ${String(error)} ${line}`; }
      }
    });
  }

  async command(command: RpcCommand): Promise<RpcResponse> {
    const id = randomUUID();
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi RPC timeout (${command.type}): ${this.stderr}\n${JSON.stringify(this.events.slice(-5))}`)); }, 30_000);
      this.pending.set(id, (event) => { clearTimeout(timer); this.pending.delete(id); resolve(event); });
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
    assert.ok(response.success, JSON.stringify(response));
    return response;
  }

  async state() {
    const response = await this.command({ type: "get_state" });
    assert.ok(response.success && response.command === "get_state");
    return response.data;
  }

  async stop(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const closed = once(this.process, "close");
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill(), 2_000);
    try { await closed; } finally { clearTimeout(timer); }
  }
}

async function until(predicate: () => boolean | Promise<boolean>, message: string | (() => Promise<string>)): Promise<void> {
  for (let attempt = 0; attempt < 800; attempt++) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(typeof message === "string" ? message : await message());
}

for (const history of [true, false]) {
  test(`real Pi first-command submission, reconnect, output, apply and native merge (history=${history})`, { timeout: 90_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi cloud native "));
    const cwd = join(root, "repo");
    const agentDir = join(root, "agent");
    const workerDir = join(root, "worker");
    const statePath = join(agentDir, "pi-cloud.json");
    await mkdir(cwd, { recursive: true });
    const run = promisify(execFile);
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) await run("git", args, { cwd });
    await writeFile(join(cwd, "file.txt"), "before\n");
    await run("git", ["add", "file.txt"], { cwd });
    await run("git", ["commit", "-qm", "initial"], { cwd });
    await saveClientState({ locale: "en", connections: [] }, statePath);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "test-only-provider", defaultModel: "stub", defaultProjectTrust: "never", quietStartup: true, disableInstallTelemetry: true, analytics: { enabled: false } }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "test-only-provider": { api: "openai-completions", apiKey: "FAKE_TEST_CREDENTIAL_NOT_A_REAL_KEY", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "stub" }] } } }));
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "test-only-provider": { type: "api_key", key: "FAKE_TEST_CREDENTIAL_NOT_A_REAL_KEY" } }));
    await saveWorkerConfig({ ...defaultWorkerConfig(workerDir), runner: "host", host: "127.0.0.1" });
    const worker = await startWorkerServer({ dataDir: workerDir, publicIp: "127.0.0.1", port: 0, piVersion: VERSION, nodeVersion: process.version, gitVersion: "git", enableExecution: false });
    const clients: NativePi[] = [];
    t.after(async () => {
      for (const client of clients) await client.stop();
      await worker.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    const pairing = await updateWorkerState(workerDir, (state) => ({ ...createPairing(state), fingerprint: state.certificateFingerprint! }));
    const uploads: string[] = [];
    let submissionConfirmations = 0;
    const answer = (request: RpcExtensionUIRequest): RpcExtensionUIResponse | undefined => {
      if (request.method === "input") return { type: "extension_ui_response", id: request.id,
        value: request.title.startsWith("1/3") ? "perform the remote task" : `/cloud-pair ${worker.url}/ ${pairing.fingerprint} ${pairing.code}` };
      if (request.method === "confirm") {
        if (!history && request.title.startsWith("3/3")) {
          assert.equal(uploads.length, 0, "no upload before final consent");
          submissionConfirmations++;
          return { type: "extension_ui_response", id: request.id, confirmed: submissionConfirmations > 1 };
        }
        return { type: "extension_ui_response", id: request.id, confirmed: true };
      }
      if (request.method === "select") {
        const option = request.options.find((option) => option.startsWith("No Worker yet:")) ||
          request.options.find((option) => option.startsWith("Worker installed:")) ||
          request.options.find((option) => option === "Review and apply files") ||
          request.options.find((option) => option === "Merge remote conversation") ||
          request.options.find((option) => option.startsWith("Run this project in the cloud")) ||
          (!history && request.options.find((option) => option.startsWith("☑ Current conversation"))) ||
          (!history && request.options.find((option) => /^☐ Pi provider credentials/i.test(option))) ||
          request.options.find((option) => option.startsWith("Next: review"));
        assert.ok(option, JSON.stringify(request));
        return { type: "extension_ui_response", id: request.id, value: option };
      }
      return undefined;
    };
    let client = new NativePi(cwd, agentDir, answer);
    clients.push(client);
    const commands = await client.command({ type: "get_commands" });
    assert.ok(commands.success && commands.command === "get_commands");
    assert.ok(commands.data.commands.some((command) => command.name === "cloud-submit"), client.stderr);
    if (history) await client.command({ type: "prompt", message: `/cloud-pair ${worker.url}/ ${pairing.fingerprint} ${pairing.code}` });
    let interruptUpload = history;
    worker.server.prependListener("request", (request) => {
      if (request.method !== "POST" || !request.url?.startsWith("/artifacts/")) return;
      uploads.push(request.url);
      if (interruptUpload && request.url.startsWith("/artifacts/workspace-")) {
        interruptUpload = false;
        request.socket.destroy();
      }
    });
    await client.command({ type: "prompt", message: history ? "/cloud-submit perform the remote task" : "/cloud" });
    assert.equal((await loadClientState(statePath)).connections.length, 1, JSON.stringify(client.events));
    if (!history) {
      const screens = client.events.filter((event) => event.type === "extension_ui_request" && event.method === "select");
      assert.ok(screens.some((event) => event.title.includes("--worker --lang en")), "the wizard must show a real Worker install command");
      assert.ok(screens.some((event) => event.title.startsWith("2/3") && event.title.replace(/\\/g, "/").includes(cwd.replace(/\\/g, "/")) && event.title.includes("Git history")), "first sync must explain the actual project upload scope");
    }
    if (history) {
      await until(async () => (await loadClientState(statePath)).tasks?.[0]?.status === "failed", async () => JSON.stringify({
        error: "interrupted upload was not retained", saved: (await loadClientState(statePath)).tasks?.map(({ status, error }) => ({ status, error })),
        events: client.events.slice(-15), stderr: client.stderr, uploads,
      }));
      assert.equal(worker.tasks.exportState().length, 0, "no task may run before uploads finish");
      const failed = (await loadClientState(statePath)).tasks![0]!;
      await client.stop();
      client = new NativePi(cwd, agentDir, answer, ["-c"]);
      clients.push(client);
      await client.state();
      await client.command({ type: "prompt", message: "/cloud-retry" });
      assert.ok((await loadClientState(statePath)).tasks?.some((item) => item.taskId === failed.taskId && item.status === "failed"), "retry retains failed-task history");
      assert.equal(uploads.filter((url) => url.startsWith("/artifacts/environment-")).length, 1, "retry reuses the already uploaded environment");
    }
    await until(() => worker.tasks.exportState().length === 1, JSON.stringify(client.events));
    const record = worker.tasks.exportState()[0]!;
    const task = record.task;
    const original = await client.state();
    const originalPath = original.sessionFile!;
    if (!history) assert.equal(submissionConfirmations, 2, "declining final consent must return to the draft, not upload or lose choices");
    assert.equal(task.runner, "host");
    assert.equal(task.artifacts.some((artifact) => artifact.kind === "session"), history);
    assert.equal(task.secretIds.length, history ? 0 : 1, "credentials must require an explicit toggle and confirmation");
    assert.ok((await readFile(originalPath, "utf8")).includes(original.sessionId));
    await until(async () => !!(await loadClientState(statePath)).tasks?.find((item) => item.taskId === task.taskId)?.accepted, async () => JSON.stringify({
      error: "submission acknowledgement not persisted", saved: (await loadClientState(statePath)).tasks?.map(({ taskId, accepted, status, cursor, error }) => ({ taskId, accepted, status, cursor, error })),
      events: client.events.slice(-15), stderr: client.stderr, worker: record.events.slice(-5),
    }));
    assert.equal((await loadClientState(statePath)).tasks!.find((item) => item.taskId === task.taskId)!.sessionId, original.sessionId, "local and remote session associations must remain separate");
    await client.command({ type: "prompt", message: "/skill:example raw remote input" });
    await until(() => worker.tasks.get(task.taskId)!.inputs.length === 1, "slash input was not forwarded");
    assert.equal(worker.tasks.get(task.taskId)!.inputs[0]!.message, "/skill:example raw remote input");
    assert.ok(!client.events.some((event) => event.type === "agent_start"), "no local model turn may run during cloud handoff");

    await client.command({ type: "prompt", message: "/cloud-reconnect" });
    await client.command({ type: "prompt", message: "/cloud-reconnect" });
    await client.command({ type: "prompt", message: "one input after replacing sockets" });
    await until(() => worker.tasks.get(task.taskId)!.inputs.length === 2, "replacement socket lost input");
    await client.stop();
    worker.tasks.log(task.taskId, { rpc: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "offline reply\u001b]52;c;UNSAFE\u0007" }] } } });
    client = new NativePi(cwd, agentDir, answer, ["-c"]);
    clients.push(client);
    assert.equal((await client.state()).sessionId, original.sessionId, "pi -c must find first-command checkpoint");
    await until(() => client.events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetLines?.some((line) => line.includes("offline reply"))), "missed assistant output was not replayed");
    const entries = await client.command({ type: "get_entries" });
    assert.ok(entries.success && entries.command === "get_entries");
    const live = entries.data.entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-cloud-live");
    assert.ok(live.some((entry) => JSON.stringify(entry).includes("offline reply")));
    assert.ok(!JSON.stringify(live).includes("UNSAFE"));

    const artifacts = await ArtifactStore.open(workerDir);
    const uploadedSession = task.artifacts.find((artifact) => artifact.kind === "session");
    const base = uploadedSession ? parseSessionArchive((await artifacts.read(uploadedSession.id)).toString("utf8")) : {
      header: { type: "session", version: 3, id: task.session.sessionId, cwd: workerDir, timestamp: new Date().toISOString() }, entries: [] as SessionEntry[], leafId: null,
    };
    const userId = randomUUID().slice(0, 8);
    const resultEntries = [
      ...base.entries,
      { type: "message", id: userId, parentId: base.leafId, timestamp: new Date().toISOString(), message: { role: "user", content: task.prompt, timestamp: Date.now() } },
      { type: "message", id: randomUUID().slice(0, 8), parentId: userId, timestamp: new Date().toISOString(), message: {
        role: "assistant", content: [{ type: "text", text: "native remote result" }], api: "openai-completions", provider: "test", model: "stub", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } },
    ];
    const sessionArtifactId = `${task.taskId}-remote-session`;
    await artifacts.put(sessionArtifactId, Buffer.from([base.header, ...resultEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n"), "application/jsonl");
    const resultArtifactId = `${task.taskId}-remote-result`;
    const files = [{ path: "file.txt", status: "modified" as const, sha256: sha256("remote\n"), contentBase64: Buffer.from("remote\n").toString("base64") }];
    await artifacts.put(resultArtifactId, Buffer.from(JSON.stringify({ baseline: task.git, files, snapshotSha256: snapshotDigest({ baseline: task.git, files }) })), "application/json");
    worker.tasks.settle(task.taskId, "completed", { sessionArtifactId, resultArtifactId });
    await until(async () => (await loadClientState(statePath)).tasks?.find((item) => item.taskId === task.taskId)?.sessionArtifactId === sessionArtifactId, "terminal results not retained");
    await client.command({ type: "prompt", message: "do not start a local turn before merging" });
    assert.ok(!client.events.some((event) => event.type === "agent_start"));
    if (history) {
      await client.command({ type: "prompt", message: "/cloud-apply" });
      await client.command({ type: "prompt", message: "/cloud-merge" });
    } else await client.command({ type: "prompt", message: "/cloud" });
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "remote\n", JSON.stringify(client.events));
    const merged = await client.state();
    assert.notEqual(merged.sessionId, original.sessionId, JSON.stringify(client.events));
    assert.equal(dirname(merged.sessionFile!), dirname(originalPath), "merge must land in Pi's native session directory, not .pi in the Git worktree");
    assert.equal(await readFile(originalPath, "utf8").then((text) => parseSessionArchive(text).header.id), original.sessionId);
    const native = SessionManager.open(merged.sessionFile!);
    assert.ok(native.buildSessionContext().messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("native remote result")));
    assert.equal(SessionManager.continueRecent(cwd, dirname(merged.sessionFile!)).getSessionId(), merged.sessionId);
    assert.deepEqual((await run("git", ["status", "--porcelain"], { cwd })).stdout.trim(), "M file.txt");
    assert.ok(!client.events.some((event) => event.type === "extension_error"), JSON.stringify(client.events));
    assert.ok(!client.events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error"), JSON.stringify(client.events));
  });
}

const dockerIntegration = process.env.PI_CLOUD_TEST_DOCKER === "1";
test(`real Worker Pi (${dockerIntegration ? "docker" : "host"}) restores a provider, skill and tool, forwards its dialog and removes runtime credentials`, {
  timeout: 90_000,
  // Worker execution is Linux-only. Node 24's Windows native RPC shutdown can abort in libuv (UV_HANDLE_CLOSING); do not reinterpret that nonzero exit as success.
  skip: process.platform !== "linux" ? "Linux Worker runtime; native Windows/macOS client flows are exercised above" : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-real-worker-"));
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  const workerDir = join(root, "worker");
  const requests: Array<{ authorization?: string; body: string }> = [];
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const first = requests.length === 1;
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "call-synced", type: "function", function: { name: "synced_write", arguments: JSON.stringify({ text: "real Worker file change\n" }) } }] } : { role: "assistant", content: "real Worker reply" };
    for (const [content, finish] of [[delta, null], [{}, first ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "completion-test", object: "chat.completion.chunk", model: "stub", created: 1, choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, dockerIntegration ? "0.0.0.0" : "127.0.0.1", resolve));
  const providerHost = dockerIntegration
    ? (await promisify(execFile)("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"])).stdout.trim()
    : "127.0.0.1";
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(agentDir, "skills", "synced"), { recursive: true });
  const run = promisify(execFile);
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) await run("git", args, { cwd });
  await writeFile(join(cwd, "file.txt"), "before\n");
  await run("git", ["add", "file.txt"], { cwd });
  await run("git", ["commit", "-qm", "initial"], { cwd });
  await saveClientState({ locale: "en", connections: [] }, join(agentDir, "pi-cloud.json"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "fixture", defaultModel: "stub", disableInstallTelemetry: true, analytics: { enabled: false } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "CLOUD_TEST_KEY", baseUrl: `http://${providerHost}:${address.port}/v1`, models: [{ id: "stub" }] } } }));
  await writeFile(join(agentDir, "skills", "synced", "SKILL.md"), "---\nname: synced\ndescription: Synchronized test skill\n---\nSYNCHRONIZED_SKILL\n");
  await writeFile(join(agentDir, "extensions", "synced.ts"), `
    import { Type } from "typebox";
    import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    export default (pi) => pi.registerTool({
      name: "synced_write", label: "Synced write", description: "Verify the synchronized runtime", parameters: Type.Object({ text: Type.String() }),
      async execute(_id, params, _signal, _update, ctx) {
        const skill = await readFile(join(process.env.PI_CODING_AGENT_DIR, "skills/synced/SKILL.md"), "utf8");
        if (!skill.includes("SYNCHRONIZED_SKILL")) throw new Error("skill was not synchronized");
        if (!await ctx.ui.confirm("Remote authorization test", "Allow this fixture tool?")) throw new Error("remote dialog was not forwarded");
        const path = join(ctx.cwd, "file.txt");
        await withFileMutationQueue(path, () => writeFile(path, params.text));
        return { content: [{ type: "text", text: "synced tool completed" }], details: {} };
      }
    });
  `);
  await saveWorkerConfig({ ...defaultWorkerConfig(workerDir), runner: dockerIntegration ? "docker" : "host", dockerNetwork: dockerIntegration ? "bridge" : "none", host: "127.0.0.1" });
  // Exercise the production bootstrap and default runner/image, not a test-only command override.
  const worker = await startWorkerServer({ dataDir: workerDir, publicIp: "127.0.0.1", port: 0, piVersion: VERSION, nodeVersion: process.version, gitVersion: "git" });
  const client = new NativePi(cwd, agentDir, (request) => {
    if (request.method === "confirm") return { type: "extension_ui_response", id: request.id, confirmed: true };
    if (request.method === "select") {
      const option = request.options.find((option) => /^☐ Pi provider credentials/i.test(option)) ?? request.options.find((option) => option.startsWith("Next: review"));
      assert.ok(option, JSON.stringify(request));
      return { type: "extension_ui_response", id: request.id, value: option };
    }
    return undefined;
  });
  t.after(async () => {
    await client.stop();
    await worker.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const pairing = await updateWorkerState(workerDir, (state) => ({ ...createPairing(state), fingerprint: state.certificateFingerprint! }));
  await client.command({ type: "prompt", message: `/cloud-pair ${worker.url} ${pairing.fingerprint} ${pairing.code}` });
  await client.command({ type: "prompt", message: "/cloud-submit run the synced tool, then reply" });
  await until(() => worker.tasks.exportState().some((record) => ["completed", "failed", "aborted"].includes(record.status)), JSON.stringify(client.events));
  const record = worker.tasks.exportState()[0]!;
  assert.equal(record.status, "completed", JSON.stringify({ result: record.result, tail: record.events.slice(-10) }));
  assert.equal(requests.length, 2, JSON.stringify(record.events));
  assert.ok(requests.every((request) => request.authorization === "Bearer CLOUD_TEST_KEY"));
  assert.ok(requests[0]!.body.includes("synced_write"));
  assert.ok(client.events.some((event) => event.type === "extension_ui_request" && event.method === "confirm" && event.title.includes("Remote authorization test")));
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "before\n", "remote tools must not mutate the local workspace");
  assert.equal(await readFile(join(workerDir, "tasks", record.task.taskId, "workspace", "file.txt"), "utf8"), "real Worker file change\n");
  await assert.rejects(() => readFile(join(workerDir, "tasks", record.task.taskId, "runtime", "agent", "models.json")), { code: "ENOENT" });
  assert.ok(record.result?.resultArtifactId && record.result.sessionArtifactId);
  await until(async () => !!(await loadClientState(join(agentDir, "pi-cloud.json"))).tasks?.[0]?.sessionArtifactId, "real result was not received");
  await client.command({ type: "prompt", message: "/cloud-apply" });
  await client.command({ type: "prompt", message: "/cloud-merge" });
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "real Worker file change\n");
  const merged = await client.command({ type: "get_last_assistant_text" });
  assert.ok(merged.success && merged.command === "get_last_assistant_text");
  assert.equal(merged.data.text, "real Worker reply", JSON.stringify(client.events));
  assert.ok(!JSON.stringify(client.events).includes("CLOUD_TEST_KEY"), "credentials must never be rendered or logged by the client");
});
