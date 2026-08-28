import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import { readFile } from "node:fs/promises";

import { buildEnvironmentManifest } from "../environment.js";
import { encodeFrame, type WorkerIdentity } from "../protocol.js";
import { authenticateToken, completePairing } from "./pairing.js";
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "./artifacts.js";
import { SecretStore } from "./secrets.js";
import { loadWorkerConfig } from "./config.js";
import {
  cleanupPreparedTask,
  collectTaskResults,
  prepareTask,
} from "./execution.js";
import { loadWorkerState, saveWorkerState } from "./state.js";
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

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_ARTIFACT_BYTES)
      throw new Error("request exceeds artifact size limit");
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
  state.certificateFingerprint = tls.fingerprint;
  await saveWorkerState(options.dataDir, state);
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
  const server = createHttpsServer(tlsOptions, async (request, response) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `https://${request.headers.host ?? `${options.publicIp}:${config.port}`}`,
      );
      if (request.method === "GET" && url.pathname === "/health")
        return json(response, 200, { ok: true, protocolVersion: 1 });
      if (request.method === "POST" && url.pathname === "/pair") {
        const input = JSON.parse((await body(request)).toString("utf8")) as {
          code?: unknown;
        };
        if (typeof input.code !== "string")
          return json(response, 400, { error: "PAIRING_CODE_INVALID" });
        Object.assign(state, await loadWorkerState(options.dataDir));
        const token = completePairing(state, input.code);
        await saveWorkerState(options.dataDir, state);
        return json(response, 200, {
          token,
          workerId: state.workerId,
          certificateFingerprint: state.certificateFingerprint,
        });
      }
      if (!authorized(request, state))
        return json(response, 401, { error: "AUTH_REQUIRED" });
      if (request.method === "GET" && url.pathname === "/worker/manifest")
        return json(response, 200, {
          manifest,
          certificateFingerprint: state.certificateFingerprint,
        });
      if (request.method === "POST" && url.pathname.startsWith("/secrets/")) {
        const id = decodeURIComponent(url.pathname.slice("/secrets/".length));
        if (!/^[A-Za-z0-9._-]+$/.test(id))
          return json(response, 400, { error: "SECRET_INVALID" });
        const version = Number(request.headers["x-secret-version"] ?? 1);
        const metadata = await secrets.put(
          id,
          version,
          (await body(request)).toString("utf8"),
        );
        return json(response, 201, metadata);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/secrets/")) {
        const id = decodeURIComponent(url.pathname.slice("/secrets/".length));
        return json(response, (await secrets.revoke(id)) ? 200 : 404, { id });
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
      return json(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const identity: WorkerIdentity = {
    workerId: state.workerId,
    address: `https://${options.publicIp}:${options.port ?? config.port}`,
    certificateFingerprint: state.certificateFingerprint ?? tls.fingerprint,
    capabilities: {
      piVersion: options.piVersion,
      nodeVersion: options.nodeVersion,
      gitVersion: options.gitVersion,
      runners: [config.runner],
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      dockerAvailable: config.runner === "docker",
    },
  };
  const persistedTasks = await loadTaskRecords(options.dataDir);
  let persistence = Promise.resolve();
  const tasks = new WorkerTaskManager((records) => {
    persistence = persistence
      .catch(() => undefined)
      .then(() => saveTaskRecords(options.dataDir, records));
    void persistence.catch(() => undefined);
  });
  tasks.restore(persistedTasks);
  await persistence;
  const executor =
    options.enableExecution === false
      ? null
      : new PiRpcExecutor(tasks, {
          cwd: options.dataDir,
          runner: createExecutionRunner(config.runner),
          ...(options.rpcCommand ? { command: options.rpcCommand } : {}),
          ...(options.rpcArgs ? { baseArgs: options.rpcArgs } : {}),
        });
  const startedTasks = new Set<string>();
  const taskLifecycle = tasks.subscribe((event) => {
    const status = event.payload.status;
    const record = tasks.get(event.taskId);
    if (
      status === "running" &&
      record &&
      executor &&
      !startedTasks.has(event.taskId)
    ) {
      startedTasks.add(event.taskId);
      void prepareTask(options.dataDir, artifacts, secrets, record)
        .then((prepared) =>
          executor.start(
            record,
            prepared.sessionPath,
            prepared.workspace,
            async (succeeded) => {
              try {
                return succeeded
                  ? await collectTaskResults(artifacts, record, prepared)
                  : {};
              } finally {
                await cleanupPreparedTask(prepared);
              }
            },
            prepared.runtimeAgentDir
              ? { PI_CODING_AGENT_DIR: prepared.runtimeAgentDir }
              : {},
          ),
        )
        .catch((error: unknown) =>
          tasks.settle(event.taskId, "failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    } else if (status === "aborted") {
      executor?.abort(event.taskId);
    } else if (status === "completed" || status === "failed") {
      startedTasks.delete(event.taskId);
    }
  });
  const taskSocket = attachTaskWebSocket(server, state, identity, tasks);
  const listenPort = options.port ?? config.port;
  await new Promise<void>((resolve) =>
    server.listen(listenPort, config.host, resolve),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : listenPort;
  tasks.startRestored();
  for (const record of persistedTasks.filter(
    (item) => item.status === "running" && tasks.get(item.task.taskId)?.status === "running",
  )) {
    tasks.log(record.task.taskId, {
      status: "recovered",
      message: "Task was interrupted by a Worker restart",
    });
  }
  return {
    server,
    tasks,
    url: `https://${options.publicIp}:${port}`,
    close: async () => {
      taskLifecycle();
      executor?.dispose();
      await taskSocket.close();
      await persistence;
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function notImplementedWorkerEvent(): string {
  return encodeFrame({
    type: "error",
    error: { code: "INTERNAL_ERROR", retryable: false },
  });
}
