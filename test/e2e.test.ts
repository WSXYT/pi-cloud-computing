import assert from "node:assert/strict";
import { request } from "node:https";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { createPairing } from "../src/worker/pairing.js";
import { encodeFrame, parseFrame, type TaskSpec } from "../src/protocol.js";
import { startWorkerServer } from "../src/worker/server.js";
import { loadWorkerState, saveWorkerState } from "../src/worker/state.js";

async function pair(url: string, code: string): Promise<{ token: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${url}/pair`);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        rejectUnauthorized: false,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              token: string;
            },
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ code }));
  });
}

const task: TaskSpec = {
  taskId: "e2e-task",
  projectId: "project-1",
  prompt: "run",
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
    sessionId: "session-1",
    baseLeafId: null,
    lastEntryId: null,
    entriesSha256: "entries",
  },
  artifacts: [],
  secretIds: [],
};

test("pairs over HTTPS, uploads state, executes a queued task, and returns events over WSS", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-e2e-"));
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
    enableExecution: false,
  });
  try {
    const paired = await pair(worker.url, pairing.code);
    const upload = await new Promise<number>((resolve, reject) => {
      const parsed = new URL(`${worker.url}/artifacts/e2e-manifest`);
      const req = request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            authorization: `Bearer ${paired.token}`,
            "content-type": "application/json",
            "content-length": 2,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(upload, 201);
    const events: string[] = [];
    const socket = new WebSocket(
      `${worker.url.replace("https:", "wss:")}/events`,
      {
        rejectUnauthorized: false,
        headers: { authorization: `Bearer ${paired.token}` },
      },
    );
    socket.on("message", (raw) => events.push(raw.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(encodeFrame({ type: "task_create", task }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    worker.tasks.settle(task.taskId, "completed", {
      resultArtifactId: "result-1",
    });
    for (
      let i = 0;
      i < 20 && !events.some((line) => line.includes('"completed"'));
      i += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      events.some((line) => parseFrame(line).type === "task_accepted"),
      true,
    );
    assert.equal(
      events.some((line) => line.includes('"completed"')),
      true,
    );
    socket.terminate();
  } finally {
    await worker.close();
  }
});
