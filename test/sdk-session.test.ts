import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { createSdkTaskSession } from "../src/worker/sdk-session.js";

// Component-host contract test, not a substitute for remote/PTY acceptance.
test("SDK task session keeps plugin custom callbacks cloud-side and fails closed on session replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-sdk-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], analytics: { enabled: false }, disableInstallTelemetry: true }));
  await writeFile(join(agentDir, "auth.json"), "{}");
  const sessionPath = join(root, "session.jsonl");
  await writeFile(sessionPath, JSON.stringify({ type: "session", version: 3, id: "sdk-task", timestamp: new Date().toISOString(), cwd }) + "\n");
  sdk.initTheme("dark");
  const errors: string[] = [];
  let rendered = "", result: { approved: boolean; values: Set<string> } | undefined;
  const theme = { fg: (_role: string, text: string) => text } as sdk.Theme;
  const ui = {
    theme,
    custom: async <T>(factory: Parameters<sdk.ExtensionUIContext["custom"]>[0]): Promise<T> => new Promise<T>((resolve, reject) => {
      void Promise.resolve(factory({ requestRender() {} } as TUI, theme, { matches: () => false } as unknown as sdk.KeybindingsManager, value => resolve(value as T))).then(component => {
        rendered = component.render(60).join("\n");
        component.handleInput?.("\r");
      }).catch(reject);
    }),
  } as sdk.ExtensionUIContext;
  let session: sdk.AgentSession | undefined;
  try {
    session = await createSdkTaskSession(sdk, {
      cwd, agentDir, sessionPath, projectTrusted: false, ui,
      onEvent() {}, onError: error => errors.push(error.error),
      extensionFactories: [{ name: "cloud-agnostic-fixture", factory(pi) {
        pi.registerCommand("sdk-dialog", { description: "Fixture", async handler(_args, ctx) {
          assert.equal(ctx.mode, "tui"); assert.equal(ctx.hasUI, true);
          result = await ctx.ui.custom<{ approved: boolean; values: Set<string> }>((_tui, _theme, _kb, done) => {
            const values = new Set(["closure-kept-in-task"]);
            return { render: width => new Text("GENERIC_CUSTOM_UI", 0, 0).render(width), invalidate() {}, handleInput: () => done({ approved: true, values }) };
          });
        } });
        pi.registerCommand("sdk-replace", { description: "Fixture", async handler(_args, ctx) { await ctx.newSession(); } });
      } }],
    });
    await session.prompt("/sdk-dialog");
    assert.match(rendered, /GENERIC_CUSTOM_UI/);
    assert.equal(result?.approved, true);
    assert.ok(result?.values instanceof Set);
    assert.equal(result.values.has("closure-kept-in-task"), true);
    assert.equal(errors.length, 0);
    await session.prompt("/sdk-replace");
    assert.ok(errors.some(error => error.includes("CLOUD_TASK_SESSION_REPLACEMENT_UNSUPPORTED")));
    assert.equal(session.sessionManager.getSessionFile(), sessionPath);
    assert.equal(session.messages.length, 0, "extension commands must not start a model turn");
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
