import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  scanEnvironment,
  parseEnvironmentArchive,
  materializeEnvironment,
  materializeCredentials,
} from "../src/environment-archive.js";

test("materializes actual global resources, filtered packages and models while keeping credentials separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "local");
  const remote = join(root, "remote");
  const external = join(root, "external-package");
  for (const path of [
    "extensions",
    "skills/demo",
    "prompts",
    "themes",
    "sessions",
    "agents",
  ])
    await mkdir(join(agent, path), { recursive: true });
  await mkdir(external);
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({
      name: "fixture",
      pi: { extensions: ["./index.ts"] },
      dependencies: { ws: "8.21.3" },
    }),
  );
  await writeFile(join(external, "index.ts"), "export default () => {};");
  await writeFile(
    join(agent, "extensions", "demo.ts"),
    "export default () => {};",
  );
  await writeFile(
    join(agent, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: fixture\n---\nA test skill.",
  );
  await writeFile(
    join(agent, "skills", "demo", "helper.sh"),
    "#!/bin/sh\necho fixture\n",
  );
  await writeFile(join(agent, "agents", "reviewer.md"), "Review the change.");
  await writeFile(
    join(agent, "prompts", "review.md"),
    "Review this repository.",
  );
  await writeFile(join(agent, "themes", "theme.json"), "{}");
  await writeFile(
    join(agent, "sessions", "private.jsonl"),
    "old conversation must not travel",
  );
  await writeFile(
    join(agent, "pi-cloud.json"),
    '{"token":"worker-access-must-not-travel"}',
  );
  const packageFilter = {
    source: "npm:fixture@1.0.0",
    extensions: [],
    skills: ["skills/demo"],
  };
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      packages: [packageFilter, external, "npm:pi-cloud-computing"],
      compaction: { enabled: false },
      defaultProvider: "fixture",
      defaultModel: "test-model",
    }),
  );
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          apiKey: "model-key-do-not-upload",
          models: [{ id: "test-model" }],
        },
      },
    }),
  );
  await writeFile(
    join(agent, "web-search.json"),
    '{"apiKey":"plugin-key-do-not-upload","enabled":true}',
  );
  await writeFile(
    join(agent, "auth.json"),
    '{"fixture":{"type":"api_key","key":"auth-key-do-not-upload"}}',
  );
  const { archive, credentials } = await scanEnvironment({
    agentDir: agent,
    cwd: root,
    piVersion: "0.85.1",
  });
  const portable = parseEnvironmentArchive(JSON.stringify(archive));
  const decoded = portable.files
    .map((file) => Buffer.from(file.contentBase64, "base64").toString())
    .join("\n");
  assert.equal(decoded.includes("do-not-upload"), false);
  assert.equal(decoded.includes("worker-access-must-not-travel"), false);
  assert.equal(
    (credentials.files ?? [])
      .map((file) => Buffer.from(file.contentBase64, "base64").toString())
      .join("\n")
      .includes("worker-access-must-not-travel"),
    false,
  );
  assert.equal(
    portable.files.some(
      (file) => file.path.includes("sessions") || file.path === "auth.json",
    ),
    false,
  );
  assert.deepEqual(
    portable.manifest.providers.map(({ id, models }) => ({ id, models })),
    [{ id: "fixture", models: ["test-model"] }],
  );
  assert.ok(
    portable.installPaths.length > 0,
    "uploaded local package dependencies must be prepared inside the runner",
  );
  await materializeEnvironment(portable, remote);
  assert.equal(
    await readFile(join(remote, "extensions", "demo.ts"), "utf8"),
    "export default () => {};",
  );
  assert.match(
    await readFile(join(remote, "skills", "demo", "SKILL.md"), "utf8"),
    /A test skill/,
  );
  assert.equal(
    await readFile(join(remote, "agents", "reviewer.md"), "utf8"),
    "Review the change.",
  );
  const settings = JSON.parse(
    await readFile(join(remote, "settings.json"), "utf8"),
  );
  assert.deepEqual(settings.packages[0], packageFilter);
  assert.equal(
    settings.packages.some(
      (item: unknown) => item === "npm:pi-cloud-computing",
    ),
    false,
  );
  assert.equal(settings.compaction.enabled, false);
  assert.equal(
    (await readFile(join(remote, "models.json"), "utf8")).includes(
      "model-key-do-not-upload",
    ),
    false,
  );
  await materializeCredentials(JSON.stringify(credentials), remote, portable);
  assert.match(
    await readFile(join(remote, "models.json"), "utf8"),
    /model-key-do-not-upload/,
  );
  assert.match(
    await readFile(join(remote, "web-search.json"), "utf8"),
    /plugin-key-do-not-upload/,
  );
  assert.match(
    await readFile(join(remote, "auth.json"), "utf8"),
    /auth-key-do-not-upload/,
  );
});

test("deselected environment cannot be reintroduced by credential configuration overlays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "local");
  const remote = join(root, "remote");
  await mkdir(local);
  await writeFile(
    join(local, "models.json"),
    '{"providers":{"test":{"apiKey":"fake-key"}}}',
  );
  await writeFile(
    join(local, "auth.json"),
    '{"test":{"type":"api_key","key":"fake-key"}}',
  );
  const { credentials } = await scanEnvironment({
    agentDir: local,
    cwd: root,
    piVersion: "0.85.1",
  });
  await materializeCredentials(JSON.stringify(credentials), remote);
  assert.match(await readFile(join(remote, "auth.json"), "utf8"), /fake-key/);
  await assert.rejects(() => readFile(join(remote, "models.json")), {
    code: "ENOENT",
  });
});

test("rejects corrupted or escaping runtime archives before materialization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-env-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { archive } = await scanEnvironment({
    agentDir: root,
    cwd: root,
    piVersion: "0.85.1",
  });
  const tampered = structuredClone(archive);
  tampered.files[0]!.contentBase64 = Buffer.from("changed").toString("base64");
  assert.throws(
    () => parseEnvironmentArchive(JSON.stringify(tampered)),
    /hash mismatch/,
  );
  const escape = structuredClone(archive);
  escape.files[0]!.path = "../outside.json";
  assert.throws(
    () => parseEnvironmentArchive(JSON.stringify(escape)),
    /unsafe archive path/,
  );
  const duplicate = structuredClone(archive);
  duplicate.files.push(duplicate.files[0]!);
  assert.throws(
    () => parseEnvironmentArchive(JSON.stringify(duplicate)),
    /duplicate environment file/,
  );
});
