import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildEnvironmentManifest } from "../environment.js";
import { PiCloudError } from "../errors.js";
import { validateIdentifier } from "../paths.js";
import { type WorkerIdentity } from "../protocol.js";
import { PROTOCOL_VERSION } from "../version.js";
import { authenticateToken, completePairing } from "./pairing.js";
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifacts.js";
import { SecretStore } from "./secrets.js";
import { loadWorkerConfig } from "./config.js";
import {
  cleanupPreparedTask,
  cleanupInterruptedRuntime,
  collectTaskResults,
  prepareTask,
} from "./execution.js";
import { loadWorkerState, updateWorkerState } from "./state.js";
import { ensureSelfSignedCertificate } from "./tls.js";
import { PiRpcExecutor } from "./rpc.js";
import { createExecutionRunner } from "./runner.js";
import { attachTaskWebSocket } from "./ws.js";
import { loadTaskRecords, saveTaskRecords } from "./task-store.js";
import { WorkerTaskManager } from "./tasks.js";

export interface WorkerServerOptions {
  dataDir: string;
  publicIp: string;
  piVersion: string;
  nodeVersion: string;
  gitVersion: string;
  port?: number;
  enableExecution?: boolean;
  rpcCommand?: string;
  rpcArgs?: string[];
}

export interface WorkerServer {
  server: HttpsServer;
  url: string;
  close(): Promise<void>;
  tasks: WorkerTaskManager;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function tokenFrom(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function authorized(
  request: IncomingMessage,
  state: Awaited<ReturnType<typeof loadWorkerState>>,
): boolean {
  const token = tokenFrom(request);
  return token !== null && authenticateToken(state, token) !== null;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function body(request: IncomingMessage, limit = MAX_ARTIFACT_BYTES): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > limit) throw new HttpError(413, "REQUEST_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function startWorkerServer(
  options: WorkerServerOptions,
): Promise<WorkerServer> {
  const config = await loadWorkerConfig(options.dataDir);
  const tls = await ensureSelfSignedCertificate(
    options.dataDir,
    options.publicIp,
  );
  const state = await loadWorkerState(options.dataDir);
  if (state.certificateFingerprint !== tls.fingerprint) {
    await updateWorkerState(options.dataDir, (current) => { current.certificateFingerprint = tls.fingerprint; });
    state.certificateFingerprint = tls.fingerprint;
  }
  const dockerAvailable =
    config.runner === "docker" &&
    (await promisify(execFile)(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeout: 5_000 },
    ).then(
      () => true,
      () => false,
    ));
  const addressHost = options.publicIp.includes(":")
    ? `[${options.publicIp}]`
    : options.publicIp;
  const artifacts = await ArtifactStore.open(options.dataDir);
  const secrets = await SecretStore.open(options.dataDir);
  const manifest = await buildEnvironmentManifest({
    agentDir: options.dataDir,
    cwd: options.dataDir,
    piVersion: options.piVersion,
    nodeVersion: options.nodeVersion,
    platform: process.platform,
  });
  const tlsOptions = {
    cert: await readFile(tls.paths.certificate),
    key: await readFile(tls.paths.privateKey),
  };
  let pairingWindow = Date.now();
  let pairingAttempts = 0;
  const server = createHttpsServer(tlsOptions, async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "https://worker.invalid");
      if (request.method === "GET" && url.pathname === "/health")
        return json(response, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
        });
      if (request.method === "POST" && url.pathname === "/pair") {
        // Bootstrap is public, but bounded independently of authenticated artifact uploads.
        if (Date.now() - pairingWindow >= 60_000) { pairingWindow = Date.now(); pairingAttempts = 0; }
        if (++pairingAttempts > 60) throw new HttpError(429, "PAIRING_RATE_LIMITED");
        const input = JSON.parse((await body(request, 4096)).toString("utf8")) as {
          code?: unknown;
        };
        if (!input || typeof input.code !== "string")
          return json(response, 400, { error: "PAIRING_CODE_INVALID" });
        const token = await updateWorkerState(options.dataDir, (current) =>
          completePairing(current, input.code as string),
        );
        return json(response, 200, {
          token,
          workerId: state.workerId,
          certificateFingerprint: tls.fingerprint,
        });
      }
      if (!authorized(request, await loadWorkerState(options.dataDir)))
        return json(response, 401, { error: "AUTH_REQUIRED" });
      if (/^\/(artifacts|secrets)\//.test(url.pathname)) {
        try { validateIdentifier(decodeURIComponent(url.pathname.split("/").slice(2).join("/"))); }
        catch { throw new HttpError(400, "INVALID_FRAME"); }
      }
      if (request.method === "GET" && url.pathname === "/worker/manifest")
        return json(response, 200, {
          manifest,
          worker: identity,
          certificateFingerprint: tls.fingerprint,
        });
      if (request.method === "DELETE" && url.pathname === "/tokens/current") {
        await updateWorkerState(options.dataDir, (current) => {
          const token = authenticateToken(current, tokenFrom(request) ?? "");
          if (token) token.revokedAt = new Date().toISOString();
        });
        return json(response, 200, { revoked: true });
      }
      if (request.method === "GET" && url.pathname === "/secrets")
        return json(response, 200, await secrets.list(true));
      if (request.method === "POST" && url.pathname.startsWith("/secrets/")) {
        const id = decodeURIComponent(url.pathname.slice("/secrets/".length));
        if (!/^[A-Za-z0-9._-]+$/.test(id))
          return json(response, 400, { error: "SECRET_INVALID" });
        const version = Number(request.headers["x-secret-version"] ?? 1);
        if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(400, "SECRET_INVALID");
        const metadata = await secrets.put(
          id,
          version,
          (await body(request)).toString("utf8"),
        );
        return json(response, 201, metadata);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/secrets/")) {
        const id = decodeURIComponent(url.pathname.slice("/secrets/".length));
        const revoked = await secrets.revoke(id);
        if (revoked) {
          for (const record of tasks.exportState()) {
            if (record.task.secretIds.includes(id) && (record.status === "queued" || record.status === "running"))
              tasks.abort(record.task.taskId, executor !== null);
          }
          await flush();
        }
        return json(response, revoked ? 200 : 404, { id });
      }
      if (request.method === "POST" && url.pathname.startsWith("/artifacts/")) {
        const id = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        const descriptor = await artifacts.put(
          id,
          await body(request),
          request.headers["content-type"] ?? "application/octet-stream",
        );
        return json(response, 201, descriptor);
      }
      if (request.method === "HEAD" && url.pathname.startsWith("/artifacts/")) {
        const id = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        try {
          await artifacts.describe(id);
          response.writeHead(200);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          response.writeHead(404);
        }
        return response.end();
      }
      if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
        const id = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        const data = await artifacts.read(id);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": data.length,
        });
        return response.end(data);
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof HttpError) return json(response, error.status, { error: error.code });
      if (error instanceof PiCloudError) return json(response, 403, { error: error.code });
      if (error instanceof SyntaxError || error instanceof URIError) return json(response, 400, { error: "INVALID_FRAME" });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return json(response, 404, { error: "NOT_FOUND" });
      // Never echo filesystem paths, parser input, credentials or provider error bodies.
      return json(response, 500, { error: "INTERNAL_ERROR" });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 256;
  const identity: WorkerIdentity = {
    workerId: state.workerId,
    address: `https://${addressHost}:${options.port ?? config.port}`,
    certificateFingerprint: state.certificateFingerprint ?? tls.fingerprint,
    capabilities: {
      piVersion: options.piVersion,
      nodeVersion: options.nodeVersion,
      gitVersion: options.gitVersion,
      runners: [config.runner],
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      dockerAvailable,
      dockerNetwork: config.dockerNetwork,
      runtimeArchiveVersion: 1,
    },
  };
  const persistedTasks = await loadTaskRecords(options.dataDir);
  for (const record of persistedTasks)
    await cleanupInterruptedRuntime(options.dataDir, record.task.taskId);
  let dirty = false;
  let persistence: Promise<void> | undefined;
  let persistenceError: unknown;
  const schedulePersistence = (): void => {
    if (persistenceError) return;
    dirty = true;
    if (persistence) return;
    persistence = (async () => {
      while (dirty) {
        dirty = false;
        await saveTaskRecords(options.dataDir, tasks.exportState());
      }
    })()
      .catch((error: unknown) => {
        persistenceError = error;
        tasks.pause();
        throw error;
      })
      .finally(() => {
        persistence = undefined;
        if (dirty && !persistenceError) schedulePersistence();
      });
    void persistence.catch(() => undefined); // flush() surfaces failure to all transport acknowledgements.
  };
  const flush = async (): Promise<void> => {
    while (persistence) await persistence;
    if (persistenceError) throw persistenceError;
  };
  const tasks = new WorkerTaskManager(schedulePersistence);
  tasks.restore(persistedTasks);
  await flush();
  const executor =
    options.enableExecution === false
      ? null
      : new PiRpcExecutor(tasks, {
          cwd: options.dataDir,
          runner: createExecutionRunner(config.runner, config.dockerNetwork),
          ...(options.rpcCommand ? { command: options.rpcCommand } : {}),
          ...(options.rpcArgs ? { baseArgs: options.rpcArgs } : {}),
        });
  const startedTasks = new Set<string>();
  const preparations = new Set<Promise<void>>();
  let closing = false;
  const taskLifecycle = tasks.subscribe((event) => {
    const status = event.payload.status;
    const record = tasks.get(event.taskId);
    if (event.kind !== "status") return;
    if (
      status === "running" &&
      record &&
      executor &&
      !closing &&
      !startedTasks.has(event.taskId)
    ) {
      startedTasks.add(event.taskId);
      const preparing = prepareTask(options.dataDir, artifacts, secrets, record)
        .then(async (prepared) => {
          if (closing || record.status === "aborted") {
            await cleanupPreparedTask(prepared);
            tasks.complete({
              taskId: event.taskId,
              status: record.status === "aborted" ? "aborted" : "failed",
              retryable: closing,
            });
            return;
          }
          try {
            executor.start(
              record,
              prepared.sessionPath,
              prepared.workspace,
              async () => {
                try {
                  return await collectTaskResults(artifacts, record, prepared);
                } finally {
                  await cleanupPreparedTask(prepared);
                }
              },
              prepared.env,
            );
          } catch (error) {
            await cleanupPreparedTask(prepared);
            throw error;
          }
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (record.status === "aborted")
            tasks.complete({
              taskId: event.taskId,
              status: "aborted",
              error: message,
            });
          else
            tasks.settle(event.taskId, "failed", {
              error: message,
              retryable: closing,
            });
        })
        .finally(() => preparations.delete(preparing));
      preparations.add(preparing);
    } else if (status === "aborted") {
      executor?.abort(event.taskId);
    } else if (status === "completed" || status === "failed") {
      startedTasks.delete(event.taskId);
    }
  });
  const taskSocket = attachTaskWebSocket(server, state, identity, tasks, {
    getState: () => loadWorkerState(options.dataDir),
    flush,
    acceptsInput: (taskId) => executor?.acceptsInput(taskId) ?? true,
    answerUi: (response) => {
      if (!executor?.answerUi(response))
        throw new Error("task is no longer accepting dialogs");
    },
    deferAbort: executor !== null,
    enforceRunner: executor !== null,
  });
  const listenPort = options.port ?? config.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : listenPort;
  tasks.startRestored();
  for (const record of persistedTasks.filter(
    (item) =>
      item.status === "running" &&
      tasks.get(item.task.taskId)?.status === "running",
  )) {
    tasks.log(record.task.taskId, {
      status: "recovered",
      message: "Task was interrupted by a Worker restart",
    });
  }
  return {
    server,
    tasks,
    url: `https://${addressHost}:${port}`,
    close: async () => {
      closing = true;
      tasks.pause();
      taskLifecycle();
      await taskSocket.close();
      await Promise.all(preparations);
      await executor?.dispose();
      await flush();
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
