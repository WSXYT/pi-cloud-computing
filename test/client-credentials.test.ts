import assert from "node:assert/strict";
import test from "node:test";
import { hasProviderCredentials } from "../src/client-credentials.js";
import type { RuntimeCredentials } from "../src/environment-archive.js";
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
