import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "pi-cloud-package-"));
const cwd = join(root, "consumer");
const agentDir = join(root, "agent");
const npm = process.env.npm_execpath;
assert.ok(npm, "Run through npm run pack:smoke");
const pi = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
let child;
try {
  await mkdir(cwd);
  await mkdir(agentDir);
  const packed = await exec(process.execPath, [npm, "pack", "--json", "--pack-destination", root], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const metadataOutput = JSON.parse(packed.stdout);
  const [{ filename }] = Array.isArray(metadataOutput) ? metadataOutput : Object.values(metadataOutput);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "cloud-smoke-consumer", private: true }));
  await exec(process.execPath, [npm, "install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", join(root, filename)], { cwd, timeout: 120_000 });
  const installed = join(cwd, "node_modules", "pi-cloud-computing");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.ok(metadata.keywords.includes("pi-package"));
  for (const path of ["src/client.ts", "dist/src/cli.js", "dist/src/worker/bootstrap.js", "deploy/Dockerfile", "deploy/runner.Dockerfile", "scripts/install.sh", "scripts/install.ps1"]) await readFile(join(installed, path));
  assert.match((await exec(process.execPath, [join(installed, "dist/src/cli.js"), "--help"], { cwd })).stdout, /Usage: pi-cloud/);
  // Real Pi registration/loading in a fresh profile; no user's packages, auth, providers or sessions.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all)$/i.test(key)));
  Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_CLOUD_CLIENT_STATE: join(agentDir, "cloud.json"), PI_SKIP_VERSION_CHECK: "1" });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], disableInstallTelemetry: true, analytics: { enabled: false } }));
  await exec(process.execPath, [pi, "install", installed], { cwd, env, timeout: 30_000 });
  child = spawn(process.execPath, [pi, "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes"], { cwd, env, stdio: "pipe" });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = once(child, "close");
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Package RPC timeout: ${stderr}`)), 30_000);
    let buffer = "";
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(`Pi exited before commands: ${stderr}`)); });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "response" && event.id === "package-smoke") { clearTimeout(timer); resolve(event); }
        } catch { /* Only JSONL responses satisfy the assertion. */ }
      }
    });
    child.stdin.write(JSON.stringify({ id: "package-smoke", type: "get_commands" }) + "\n");
  });
  assert.equal(response.success, true, JSON.stringify(response));
  for (const name of ["cloud", "cloud-pair", "cloud-submit", "cloud-apply", "cloud-merge"]) assert.ok(response.data.commands.some((entry) => entry.name === name), `${name} missing: ${stderr}`);
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 2_000);
  try { await closed; } finally { clearTimeout(timer); }
  console.log(`Package smoke passed: ${filename}; npm installation, deployment assets, CLI, Pi install and extension RPC loading verified.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close"); child.kill(); await closed;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
