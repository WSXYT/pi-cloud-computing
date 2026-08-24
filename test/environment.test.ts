import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildEnvironmentManifest,
  fingerprintSecret,
  secretValueIsChanged,
  sha256,
} from "../src/environment.js";

test("builds a redacted environment manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-env-"));
  await mkdir(join(root, "extensions"), { recursive: true });
  await writeFile(
    join(root, "settings.json"),
    JSON.stringify({ packages: ["npm:example@1.0.0"] }),
  );
  await writeFile(join(root, "extensions", "demo.ts"), "export default 1");
  const secret = fingerprintSecret("openai", 2, "secret-value");
  const manifest = await buildEnvironmentManifest({
    agentDir: root,
    cwd: root,
    piVersion: "0.84.2",
    secretVersions: [
      {
        id: secret.id,
        version: secret.version,
        value: "secret-value",
        authorized: true,
      },
    ],
  });

  assert.equal(manifest.packages[0]?.source, "npm:example@1.0.0");
  assert.equal(manifest.resources[0]?.path, "global/extensions/demo.ts");
  assert.equal(manifest.secretVersions[0]?.sha256, secret.sha256);
  assert.equal(JSON.stringify(manifest).includes("secret-value"), false);
});

test("detects secret changes by fingerprint", () => {
  const first = fingerprintSecret("provider", 1, "a");
  const same = fingerprintSecret("provider", 1, "a");
  const next = fingerprintSecret("provider", 2, "b");
  assert.equal(sha256("a").length, 64);
  assert.equal(secretValueIsChanged(first, same), false);
  assert.equal(secretValueIsChanged(first, next), true);
});
