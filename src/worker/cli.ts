import { execFile } from "node:child_process";
import { get } from "node:https";
import { promisify } from "node:util";
import { updateClientState } from "../client-state.js";
import { loadWorkerConfig, saveWorkerConfig, setWorkerConfigValue, type WorkerConfig } from "./config.js";
import { createPairing, revokeToken } from "./pairing.js";
import { loadWorkerState, updateWorkerState } from "./state.js";
import { ensureSelfSignedCertificate } from "./tls.js";
import { startWorkerServer } from "./server.js";
import { cleanupExpiredTasks, writeSystemdUnit } from "./service.js";
import { discoverWorkerAddresses } from "./network.js";

const execFileAsync = promisify(execFile);
const usage = "Usage: pi-cloud worker <install|serve|pair|ips|status|health|tokens|token revoke ID|tls rotate|cleanup|start|stop> | config set <key> <value> | client language <zh-CN|en>";
const address = (config: WorkerConfig) => `https://${config.publicIp.includes(":") ? `[${config.publicIp}]` : config.publicIp}:${config.port}`;

function pairingOutput(config: WorkerConfig, fingerprint: string, pairing: { code: string; expiresAt: string }, stdout: (message: string) => void): void {
  stdout(`address=${address(config)}`);
  stdout(`fingerprint=${fingerprint}`);
  stdout(`pairing-code=${pairing.code}`);
  stdout(`pairing-expires-at=${pairing.expiresAt}`);
  stdout(`pair-command=/cloud-pair ${address(config)} ${fingerprint} ${pairing.code}`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
  return value;
}

async function health(config: WorkerConfig): Promise<void> {
  const tls = await ensureSelfSignedCertificate(config.dataDir, config.publicIp);
  await new Promise<void>((resolve, reject) => {
    // Loopback avoids public-IP hairpin routing. Trust only the local certificate and its exact pin, not the loopback hostname.
    const request = get(`https://${config.host.includes(":") ? "[::1]" : "127.0.0.1"}:${config.port}/health`, {
      ca: tls.certificate,
      checkServerIdentity: (_host, certificate) => certificate.fingerprint256 === tls.fingerprint ? undefined : new Error("CERTIFICATE_MISMATCH"),
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 200 ? resolve() : reject(new Error(`health check failed (${response.statusCode})`)));
      response.once("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("health check timed out")), 5000);
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
  });
}

export async function runWorkerCli(args: string[], stdout = console.log): Promise<number> {
  const [scope, command, key, value] = args;
  if (scope === "--help" || scope === "-h") { stdout(usage); return 0; }
  if (scope === "client" && command === "language") {
    if (key !== "zh-CN" && key !== "en") throw new Error("language must be zh-CN or en");
    await updateClientState((state) => ({ ...state, locale: key }));
    stdout(`language=${key}`);
    return 0;
  }
  if (scope !== "worker" && scope !== "config") { stdout(usage); return 2; }
  let config = await loadWorkerConfig();
  if (scope === "config" && command === "set" && key && value) {
    await updateWorkerState(config.dataDir, async () => {
      config = setWorkerConfigValue(await loadWorkerConfig(config.dataDir), key, value);
      await saveWorkerConfig(config);
    });
    stdout(`${key}=${value}`);
    stdout("restart-required=true");
    return 0;
  }
  if (scope !== "worker") { stdout(usage); return 2; }
  if (command === "ips") { stdout(JSON.stringify(await discoverWorkerAddresses(), null, 2)); return 0; }
  if (command === "tokens") {
    const state = await loadWorkerState(config.dataDir);
    stdout(JSON.stringify(state.tokens.map(({ id, createdAt, revokedAt }) => ({ id, createdAt, revokedAt: revokedAt ?? null })), null, 2));
    return 0;
  }
  if (command === "token" && key === "revoke" && value) {
    await updateWorkerState(config.dataDir, (state) => {
      if (!revokeToken(state, value)) throw new Error("active token not found");
    });
    stdout(`revoked-token=${value}`);
    return 0;
  }
  if (command === "pair" || command === "install" || (command === "tls" && key === "rotate")) {
    if (command === "install") {
      let ip = flagValue(args, "--ip") ?? (config.publicIp === "127.0.0.1" ? undefined : config.publicIp);
      if (!ip) { const detected = await discoverWorkerAddresses(); ip = detected.publicIp ?? detected.privateIps[0]; }
      if (!ip) throw new Error("No Worker IP detected; pass --ip <address>");
      config = setWorkerConfigValue(config, "ip", ip);
    } else if (command === "tls") {
      config = setWorkerConfigValue(config, "ip", flagValue(args, "--ip") ?? (value?.startsWith("--") ? undefined : value) ?? config.publicIp);
    }
    const tls = await updateWorkerState(config.dataDir, async (state) => {
      const tls = await ensureSelfSignedCertificate(config.dataDir, config.publicIp, command === "tls");
      state.certificateFingerprint = tls.fingerprint;
      if (command === "tls") for (const token of state.tokens) token.revokedAt ??= new Date().toISOString();
      const pairing = createPairing(state);
      await saveWorkerConfig(config);
      pairingOutput(config, tls.fingerprint, pairing, stdout);
      return tls;
    });
    if (command === "install") {
      stdout(`certificate=${tls.paths.certificate}`);
      if (args.includes("--systemd")) stdout(`systemd-unit=${await writeSystemdUnit(config.dataDir, { docker: config.runner === "docker" })}`);
    }
    if (command === "tls") stdout("restart-required=true; tokens-revoked=true; restart the Worker before pairing again");
    return 0;
  }
  if (command === "status") {
    const state = await loadWorkerState(config.dataDir);
    stdout(JSON.stringify({ workerId: state.workerId, address: address(config), fingerprint: state.certificateFingerprint ?? null, locale: config.locale, runner: config.runner, dockerNetwork: config.dockerNetwork, activeTaskId: state.activeTaskId ?? null, pairingExpiresAt: state.pairingExpiresAt ?? null }, null, 2));
    return 0;
  }
  if (command === "health") { await health(config); stdout("health=ok"); return 0; }
  if (command === "serve") {
    if (process.platform !== "linux") throw new Error("Worker execution requires Linux; local Pi clients support Windows, Linux and macOS");
    const [{ stdout: piVersion }, { stdout: gitVersion }] = await Promise.all([execFileAsync("pi", ["--version"]), execFileAsync("git", ["--version"])]);
    const worker = await startWorkerServer({ dataDir: config.dataDir, publicIp: config.publicIp, piVersion: piVersion.trim(), nodeVersion: process.version, gitVersion: gitVersion.trim() });
    stdout(`listening=${worker.url}`);
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const stop = () => { if (!closing) { closing = true; void worker.close().then(resolve, reject); } };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }
  if (command === "cleanup") {
    if (config.retention !== "days" || !config.retentionDays) { stdout("retention=until-delete"); return 0; }
    stdout(JSON.stringify({ removed: await cleanupExpiredTasks(config.dataDir, config.retentionDays) }));
    return 0;
  }
  if (command === "start" || command === "stop") {
    const exitCode = await new Promise<number>((resolve) => execFile("systemctl", [command, "pi-cloud-worker.service"], (error) => resolve(error ? 1 : 0)));
    stdout(`worker ${command}: ${exitCode === 0 ? "ok" : "failed"}`);
    return exitCode;
  }
  stdout(usage);
  return 2;
}
