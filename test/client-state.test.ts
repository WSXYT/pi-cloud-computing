import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadClientState, saveClientState } from "../src/client-state.js";

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
  const restored = await loadClientState(path);
  assert.equal(restored.locale, "zh-CN");
  assert.equal(restored.connections[0]?.token, "secret");
});
