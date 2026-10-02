import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import WebSocket from "ws";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { attachTaskWebSocket } from "../src/worker/ws.js";
import { WorkerTaskManager } from "../src/worker/tasks.js";
import { newWorkerState } from "../src/worker/state.js";
import { completePairing, createPairing } from "../src/worker/pairing.js";
import { SdkComponentHost } from "../src/worker/sdk-components.js";
import type { ComponentFrame } from "../src/component-protocol.js";
import { parseFrame, type ProtocolFrame, type TaskSpec } from "../src/protocol.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail("component transport did not reach the expected state");
}

// Loopback transport contract test. Production TLS pinning is exercised separately.
test("authenticated component transport scopes input and resumes only the live component snapshot", { timeout: 10_000 }, async () => {
  const state = newWorkerState();
  const token = completePairing(state, createPairing(state).code);
  const tasks = new WorkerTaskManager();
  const task: TaskSpec = {
    taskId: "component-task", projectId: "project", prompt: "fixture", runner: "host",
    environment: { piVersion: "0.85.1", nodeVersion: "24", platform: process.platform, packages: [], resources: [], providers: [], secretVersions: [], warnings: [] },
    git: { repositoryHash: "a".repeat(64), head: "b".repeat(40), indexHash: "c".repeat(40), worktreeHash: "d".repeat(64), includedPaths: [] },
    session: { sessionId: "session", baseLeafId: null, lastEntryId: null, entriesSha256: "e".repeat(64) }, artifacts: [], secretIds: [],
  };
  tasks.create(task);
  const cache = new Map<string, ComponentFrame>();
  let inputs = 0;
  const server = createServer();
  const transport = attachTaskWebSocket(server, state, {
    workerId: state.workerId, address: "https://127.0.0.1", certificateFingerprint: "a".repeat(64),
    capabilities: { piVersion: "0.85.1", nodeVersion: "24", gitVersion: "git", runners: ["host"], maxArtifactBytes: 1024, dockerAvailable: false, dockerNetwork: "none" },
  }, tasks, { getComponents: () => [...cache.values()], componentInput: (_taskId, input) => { inputs++; host.receive(input); } });
  const host = new SdkComponentHost(frame => {
    if (frame.type === "close") cache.delete(frame.id); else cache.set(frame.id, frame);
    transport.publishComponent(task.taskId, frame);
  }, truncateToWidth);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const messages: ProtocolFrame[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/events`, { headers: { authorization: `Bearer ${token}` } });
    sockets.push(socket);
    socket.on("message", data => messages.push(parseFrame(data.toString())));
    await once(socket, "open"); return { socket, messages };
  };
  const result = { original: new Set(["closure"]) };
  const pending = host.custom(done => ({ render: () => ["CLOUD_CUSTOM_CONTENT"], invalidate() {}, handleInput: () => done(result) }));
  // Attach rejection handling before cleanup can cancel the pending component.
  void pending.catch(() => {});
  try {
    await until(() => [...cache.values()].some(frame => frame.type === "frame"));
    const id = [...cache.keys()][0]!;
    const first = await connect();
    first.socket.send(JSON.stringify({ type: "task_component_input", taskId: task.taskId, input: { type: "input", id, data: "unsubscribed" } }));
    await until(() => first.messages.some(frame => frame.type === "error"));
    assert.equal(inputs, 0);
    first.socket.send(JSON.stringify({ type: "task_resume", taskId: task.taskId, afterCursor: 0 }));
    await until(() => first.messages.some(frame => frame.type === "task_component"));
    first.socket.close(); await once(first.socket, "close");
    const resumed = await connect();
    resumed.socket.send(JSON.stringify({ type: "task_resume", taskId: task.taskId, afterCursor: tasks.snapshot(task.taskId).cursor }));
    await until(() => resumed.messages.some(frame => frame.type === "task_component"));
    const components = resumed.messages.filter(frame => frame.type === "task_component");
    assert.equal(components.length, 1);
    assert.ok(components[0]?.type === "task_component" && components[0].component.type === "frame");
    assert.ok(tasks.eventsAfter(task.taskId, 0).every(event => !JSON.stringify(event).includes("CLOUD_CUSTOM_CONTENT")), "component frames must not grow the durable journal");
    resumed.socket.send(JSON.stringify({ type: "task_component_input", taskId: task.taskId, input: { type: "input", id, data: "approve" } }));
    assert.equal(await pending, result);
    await until(() => resumed.messages.some(frame => frame.type === "task_component" && frame.component.type === "close"));
    assert.equal(cache.size, 0);
  } finally {
    host.close();
    for (const socket of sockets) socket.terminate();
    await transport.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
