import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Real isolated SDK process, cloud-agnostic plugin and JSONL transport; no model credentials.
test("SDK entry runs custom plugin interaction and shutdown in the isolated process", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-sdk-entry-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], analytics: { enabled: false }, disableInstallTelemetry: true }));
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "extensions", "interaction.ts"), `
    import { writeFileSync } from 'node:fs';
    export default function(pi) {
      pi.on('session_shutdown', () => writeFileSync('shutdown-marker', 'closed'));
      pi.registerCommand('custom-fixture', { description:'fixture', async handler(_, ctx) {
        if (ctx.mode !== 'tui') throw new Error('not tui');
        const result = await ctx.ui.custom((tui, theme, kb, done) => {
          const owned = new Set(['original closure']);
          return { render: () => [theme.fg('accent', 'PLUGIN_READY')], invalidate(){}, handleInput(data) {
            if(data === '\\r') done({owned});
          }};
        });
        if (!(result.owned instanceof Set) || !result.owned.has('original closure')) throw new Error('callback lost');
        const approved = await ctx.ui.confirm('Real standard dialog', 'Approve fixture?');
        writeFileSync('interaction-marker', approved ? 'approved' : 'declined');
      }});
    }
  `);
  const sessionPath = join(root, "session.jsonl");
  await writeFile(sessionPath, JSON.stringify({ type: "session", version: 3, id: "sdk-entry", timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all)$/i.test(key)));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/worker/sdk-entry.js", import.meta.url)), "--session", sessionPath, "--approve"], {
    cwd: root, env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_CLOUD_PI_ENTRY: fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))) }, stdio: "pipe",
  });
  const events: Record<string, any>[] = [];
  let pending = "", stderr = "";
  const answered = new Set<string>();
  const send = (event: object) => child.stdin.write(JSON.stringify(event) + "\n");
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => {
    pending += data;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      events.push(event);
      if (event.type === "extension_component" && event.component.type === "frame" && !answered.has(event.component.id)) {
        answered.add(event.component.id);
        send({ type: "prompt", id: "queued-fixture", message: "queued fixture", streamingBehavior: "followUp" });
        send({ type: "cloud_dequeue", requestId: "edit-fixture" });
        send({ type: "cloud_dequeue", requestId: "edit-fixture" });
      }
      if (event.type === "cloud_queue_restored" && events.filter(item => item.type === "cloud_queue_restored").length === 2) {
        send({ type: "extension_component_input", input: { type: "input", id: [...answered][0], data: "\r" } });
      }
      if (event.type === "extension_ui_request" && event.method === "confirm") send({ type: "extension_ui_response", id: event.id, confirmed: true });
      if (event.type === "agent_settled" || (event.type === "response" && event.success === false)) child.stdin.end();
    }
  });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    send({ type: "prompt", id: "pi-cloud-initial", message: "/custom-fixture" });
    assert.equal(await closed, 0, JSON.stringify({ events, stderr }));
    assert.ok(events.some(event => event.type === "extension_component" && event.component.type === "frame"));
    assert.ok(events.some(event => event.type === "extension_ui_closed"));
    const restored = events.filter(event => event.type === "cloud_queue_restored");
    assert.equal(restored.length, 2);
    assert.deepEqual(restored[0]!.followUp, ["queued fixture"]);
    assert.deepEqual(restored[1], restored[0], "repeated dequeue request must return its original result, not clear a new queue");
    assert.ok(!events.some(event => event.type === "agent_start"), "command-only plugin must not invoke a model");
    assert.equal(await readFile(join(root, "interaction-marker"), "utf8"), "approved");
    assert.equal(await readFile(join(root, "shutdown-marker"), "utf8"), "closed");
  } finally { clearTimeout(timer); child.kill(); await closed.catch(() => {}); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
