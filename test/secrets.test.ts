import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SecretStore } from "../src/worker/secrets.js";

test("encrypts, rotates, lists, and revokes secrets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-secrets-"));
  const store = await SecretStore.open(dataDir);
  await store.put("provider-key", 1, "top-secret");
  assert.equal(await store.get("provider-key"), "top-secret");
  await store.put("provider-key", 2, "rotated-secret");
  assert.equal(await store.get("provider-key"), "rotated-secret");
  assert.equal((await store.list()).length, 1);
  assert.equal(await store.revoke("provider-key"), true);
  assert.equal(await store.get("provider-key"), null);
  const raw = await readFile(join(dataDir, "secrets.json"), "utf8");
  assert.equal(raw.includes("top-secret"), false);
  assert.equal(raw.includes("rotated-secret"), false);
});

test("rejects tampered ciphertext", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-secrets-"));
  const store = await SecretStore.open(dataDir);
  await store.put("key", 1, "value");
  const path = join(dataDir, "secrets.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    secrets: Array<{ ciphertext: string }>;
  };
  raw.secrets[0]!.ciphertext = `${raw.secrets[0]!.ciphertext}x`;
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, JSON.stringify(raw)),
  );
  await assert.rejects(() => store.get("key"));
});
