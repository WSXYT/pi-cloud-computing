import assert from "node:assert/strict";
import { request } from "node:https";
import WebSocket from "ws";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPairing } from "../src/worker/pairing.js";
import { startWorkerServer } from "../src/worker/server.js";
import { encodeFrame, type TaskSpec } from "../src/protocol.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";

async function call(
  url: string,
  options: { method?: string; token?: string; body?: string | Buffer } = {},
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: options.method ?? "GET",
        rejectUnauthorized: false,
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.body
            ? { "content-length": Buffer.byteLength(options.body) }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const task: TaskSpec = {
  taskId: "task-ws-1",
  projectId: "project-1",
  prompt: "run tests",
  runner: "docker",
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
    sessionId: "session-1",
    baseLeafId: null,
    lastEntryId: null,
    entriesSha256: "entries",
  },
  artifacts: [],
  secretIds: [],
};

test("serves health, pairing, manifest, and authenticated artifacts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-server-"));
  const state = await loadWorkerState(dataDir);
  const pairing = createPairing(state);
  await saveWorkerState(dataDir, state);
  const worker = await startWorkerServer({
    dataDir,
    publicIp: "127.0.0.1",
    piVersion: "0.84.2",
    nodeVersion: process.version,
    gitVersion: "2.0",
    port: 0,
    enableExecution: false,
  });
  try {
    assert.equal((await call(`${worker.url}/health`)).status, 200);
    const pair = await call(`${worker.url}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: pairing.code }),
    });
    assert.equal(pair.status, 200);
    const token = (JSON.parse(pair.body.toString()) as { token: string }).token;
    assert.equal(
      (await call(`${worker.url}/worker/manifest`, { token })).status,
      200,
    );
    const uploaded = await call(`${worker.url}/artifacts/a1`, {
      method: "POST",
      token,
      body: Buffer.from("artifact"),
    });
    assert.equal(uploaded.status, 201);
    const downloaded = await call(`${worker.url}/artifacts/a1`, { token });
    assert.equal(downloaded.body.toString(), "artifact");
    assert.equal((await call(`${worker.url}/artifacts/a1`)).status, 401);
    await assert.doesNotReject(
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          `${worker.url.replace("https:", "wss:")}/events`,
          { rejectUnauthorized: false },
        );
        socket.once("open", () =>
          reject(new Error("unauthorized websocket opened")),
        );
        socket.once("error", () => resolve());
      }),
    );
    const messages: string[] = [];
    const socket = new WebSocket(
      `${worker.url.replace("https:", "wss:")}/events`,
      {
        rejectUnauthorized: false,
        headers: { authorization: `Bearer ${token}` },
      },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (message) => messages.push(message.toString()));
    socket.send(
      encodeFrame({ type: "hello", protocolVersion: 1, clientId: "client-1" }),
    );
    socket.send(encodeFrame({ type: "task_create", task }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.send(
      encodeFrame({
        type: "task_input",
        input: {
          taskId: task.taskId,
          delivery: "followUp",
          message: "also check refresh",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      messages.some((message) => message.includes('"hello_ack"')),
      true,
    );
    assert.equal(
      messages.some((message) => message.includes('"task_accepted"')),
      true,
    );
    assert.equal(
      messages.some((message) => message.includes('"also check refresh"')),
      true,
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close();
    });
  } finally {
    await worker.close();
  }
});
