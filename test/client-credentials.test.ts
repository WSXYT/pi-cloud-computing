import assert from "node:assert/strict";
import test from "node:test";
import { hasProviderCredentials } from "../src/client-credentials.js";
import { scanEnvironment, type RuntimeCredentials } from "../src/environment-archive.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("standard provider env credentials enter only the private consent bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-env-consent-"));
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-env-only-not-a-real-key";
  try {
    const { archive, credentials } = await scanEnvironment({ agentDir: join(root, "agent"), cwd: root, piVersion: "0.85.1", credentialProvider: "openai" });
    assert.equal(credentials.env.OPENAI_API_KEY, "fixture-env-only-not-a-real-key");
    assert.equal(hasProviderCredentials(credentials, "openai"), true);
    assert.equal(hasProviderCredentials(credentials, "anthropic"), false);
    assert.ok(!JSON.stringify(archive).includes("fixture-env-only-not-a-real-key"));
    assert.equal(archive.manifest.secretVersions.length, 1);
    assert.equal(archive.manifest.secretVersions[0]!.authorized, false, "default selection must not authorize use");
    const withoutProvider = await scanEnvironment({ agentDir: join(root, "agent"), cwd: root, piVersion: "0.85.1" });
    assert.equal(withoutProvider.credentials.env.OPENAI_API_KEY, undefined, "never sweep unrelated process credentials");
    assert.equal(hasProviderCredentials({ format: 1, files: [], env: { AWS_PROFILE: "local-profile" } }, "amazon-bedrock"), false);
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

const bundle = (path: string, data: object, env: Record<string, string> = {}): RuntimeCredentials => ({ format: 1, env, files: [{ path, contentBase64: Buffer.from(JSON.stringify(data)).toString("base64"), sha256: "fixture", mode: "100644" }] });

test("credential default is specific to the selected provider and never executes dynamic secrets", () => {
  assert.equal(hasProviderCredentials(bundle("auth.json", { selected: { type: "api_key", key: "fixture" } }), "selected"), true);
  assert.equal(hasProviderCredentials(bundle("auth.json", { other: { type: "api_key", key: "fixture" } }), "selected"), false);
  assert.equal(hasProviderCredentials(bundle("auth.json", { selected: { type: "oauth", refresh: "fixture" } }), "selected"), true);
  assert.equal(hasProviderCredentials(bundle("models.json", { providers: { selected: { apiKey: "!read-secret" } } }), "selected"), false);
  const config = { providers: { selected: { apiKey: "${FIXTURE_KEY}" } } };
  assert.equal(hasProviderCredentials(bundle("models.json", config), "selected"), false);
  assert.equal(hasProviderCredentials(bundle("models.json", config, { FIXTURE_KEY: "fixture" }), "selected"), true);
  assert.equal(hasProviderCredentials(bundle("models.json", { providers: { selected: { apiKey: "fixture" } } }), "selected"), true);
  assert.equal(hasProviderCredentials(bundle("auth.json", {}), undefined), false);
  assert.equal(hasProviderCredentials(bundle("auth.json", { selected: { type: "api_key", key: "${LOCAL_KEY}", env: { LOCAL_KEY: "fixture" } } }), "selected"), true);
  assert.equal(hasProviderCredentials(bundle("auth.json", { selected: { type: "api_key", key: "${LOCAL_KEY}", env: { LOCAL_KEY: 42 } } }), "selected"), false);
  assert.equal(hasProviderCredentials(bundle("models.json", { providers: { selected: { apiKey: "$$LITERAL" } } }), "selected"), true);
  const models = bundle("models.json", { providers: { selected: { models: [{ id: "wanted", headers: { "x-api-key": "fixture" } }] } } });
  assert.equal(hasProviderCredentials(models, "selected", "wanted"), true);
  assert.equal(hasProviderCredentials(models, "selected", "different"), false);
});
