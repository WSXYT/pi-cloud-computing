import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadClientState, saveClientState, updateClientState } from "../src/client-state.js";

test("persists client pairing state with a private file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-cloud-client-"));
        const path = join(dir, "pi-cloud.json");
        await saveClientState(
                {
                        locale: "zh-CN",
                        activeWorkerId: "worker-1",
                        connections: [
                                {
                                        workerId: "worker-1",
                                        baseUrl: "https://127.0.0.1:9443",
                                        fingerprint: "AA",
                                        token: "secret",
                                        pairedAt: new Date().toISOString(),
                                },
                        ],
                },
                path,
        );
        await saveClientState(
                {
                        locale: "zh-CN",
                        activeWorkerId: "worker-1",
                        connections: [
                                {
                                        workerId: "worker-1",
                                        baseUrl: "https://127.0.0.1:9443",
                                        fingerprint: "AA",
                                        token: "secret",
                                        pairedAt: new Date().toISOString(),
                                },
                        ],
                        tasks: [
                                {
                                        taskId: "task-1",
                                        workerId: "worker-1",
                                        baseUrl: "https://127.0.0.1:9443",
                                        fingerprint: "AA",
                                        projectId: dir,
                                        sessionId: "session-1",
                                        baseLeafId: null,
                                        lastEntryId: null,
                                        entriesSha256: "entries",
                                        cursor: 4,
                                        status: "running",
                                        prompt: "test",
                                        updatedAt: new Date().toISOString(),
                                },
                        ],
                },
                path,
        );
        const restored = await loadClientState(path);
        assert.equal(restored.locale, "zh-CN");
        assert.equal(restored.tasks?.[0]?.taskId, "task-1");
        assert.equal(restored.connections[0]?.token, "secret");
});

test("ignores malformed persisted connections and tasks", async () => {
        const dir = await mkdtemp(join(tmpdir(), "pi-cloud-client-invalid-"));
        const path = join(dir, "pi-cloud.json");
        await saveClientState({ connections: [] }, path);
        await (await import("node:fs/promises")).writeFile(
                path,
                JSON.stringify({
                        connections: [{ workerId: "missing-token" }],
                        tasks: [{ taskId: "missing-status" }],
                }),
        );
        const restored = await loadClientState(path);
        assert.deepEqual(restored.connections, []);
        assert.equal(restored.tasks, undefined);
});

test("accepts a Windows BOM without losing state, and preserves corrupt JSON on failed updates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-bom-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  await writeFile(path, '\uFEFF{"connections":[],"locale":"en"}');
  assert.equal((await loadClientState(path)).locale, "en");
  await writeFile(path, '{"connections":');
  await assert.rejects(() => updateClientState((state) => ({ ...state, locale: "zh-CN" }), path), /original data was preserved/);
  assert.equal(await readFile(path, "utf8"), '{"connections":');
});

test("serializes concurrent read-modify-write updates to shared client state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-state-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  await Promise.all(Array.from({ length: 12 }, (_, index) => updateClientState((state) => ({
    ...state,
    connections: [...state.connections, { workerId: `worker-${index}`, baseUrl: "https://127.0.0.1:9443", fingerprint: "AA", token: "fixture", pairedAt: new Date().toISOString() }],
  }), path)));
  assert.equal((await loadClientState(path)).connections.length, 12);
});
