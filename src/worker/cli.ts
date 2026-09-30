import { execFile } from "node:child_process";
import { get } from "node:https";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadClientState, updateClientState } from "../client-state.js";
import { CloudConnection, normalizeFingerprint } from "../client-network.js";
import { defaultDataDir, loadWorkerConfig, saveWorkerConfig, setWorkerConfigValue, type WorkerConfig } from "./config.js";
import { createPairing, revokeToken } from "./pairing.js";
import { loadWorkerState, updateWorkerState } from "./state.js";
import { ensureSelfSignedCertificate } from "./tls.js";
import { startWorkerServer } from "./server.js";
import { cleanupExpiredTasks, launchdPlistPath, WINDOWS_WORKER_TASK, WORKER_SERVICE_LABEL, writeLaunchdPlist, writeSystemdUnit, writeWindowsWorkerScript } from "./service.js";
import { ensurePrivateDirectory } from "../storage.js";
import { discoverWorkerAddresses } from "./network.js";

const execFileAsync = promisify(execFile);
const usage = "Usage: pi-cloud worker <install|serve|pair|ips|status|health|tokens|token revoke ID|tls rotate|cleanup|start|stop> | config set <key> <value> | client language <zh-CN|en> | client pair <https-url> <fingerprint> <one-time-code>";
const address = (config: WorkerConfig) => `https://${config.publicIp.includes(":") ? `[${config.publicIp}]` : config.publicIp}:${config.port}`;

async function runWorkerService(command: "start" | "stop"): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("schtasks.exe", [command === "start" ? "/Run" : "/End", "/TN", WINDOWS_WORKER_TASK], { windowsHide: true });
    return;
  }
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : undefined;
    if (!uid) throw new Error("macOS Worker service requires a user session");
    const domain = `gui/${uid}`;
    const target = `${domain}/${WORKER_SERVICE_LABEL}`;
    const plist = launchdPlistPath();
    if (command === "start") {
      try { await execFileAsync("launchctl", ["bootstrap", domain, plist]); } catch { /* Already loaded; kickstart below. */ }
      await execFileAsync("launchctl", ["kickstart", "-k", target]);
    } else {
      await execFileAsync("launchctl", ["bootout", target]);
    }
    return;
  }
  await execFileAsync("systemctl", [command, "pi-cloud-worker.service"]);
}

async function pairingOutput(config: WorkerConfig, fingerprint: string, pairing: { code: string; expiresAt: string }, stdout: (message: string) => void): Promise<void> {
  stdout(`address=${address(config)}`);
  stdout(`fingerprint=${fingerprint}`);
  stdout(`pairing-code=${pairing.code}`);
  stdout(`pairing-expires-at=${pairing.expiresAt}`);
  stdout(`pair-command=/cloud-pair ${address(config)} ${fingerprint} ${pairing.code}`);
  // Bind both installers to the exact checked-out Worker source, not mutable main.
  try {
    const source = fileURLToPath(new URL("../../../", import.meta.url));
    const [{ stdout: revision }, { stdout: changes }, { stdout: origin }] = await Promise.all([
      execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"]),
      execFileAsync("git", ["-C", source, "remote", "get-url", "origin"]),
    ]);
    if (changes.trim() || !/github\.com[:/]WSXYT\/pi-cloud-computing(?:\.git)?$/i.test(origin.trim())) throw new Error("Worker source is not a clean official checkout");
    const commit = revision.trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("invalid source revision");
    const script = `https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/${commit}/scripts`;
    stdout(`client-command-posix=curl -fsSL ${script}/install.sh | bash -s -- --client --lang ${config.locale} --pair-url '${address(config)}' --fingerprint '${fingerprint}' --code '${pairing.code}' --revision ${commit}`);
    stdout(`client-command-powershell=& { $s = (Invoke-WebRequest -UseBasicParsing '${script}/install.ps1').Content; $f = Join-Path $env:TEMP ('pi-cloud-install-' + [guid]::NewGuid() + '.ps1'); try { [IO.File]::WriteAllText($f, $s); & $f -Role client -Language ${config.locale} -PairUrl '${address(config)}' -Fingerprint '${fingerprint}' -Code '${pairing.code}' -Revision '${commit}' } finally { Remove-Item $f -ErrorAction SilentlyContinue } }`);
  } catch {
    stdout("client-install-unavailable=Worker source is not a clean official Git checkout; use a verified release installer, then the pair-command above.");
  }
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
  if (scope === "worker" || scope === "config") await ensurePrivateDirectory(defaultDataDir());
  if (scope === "client" && command === "pair") {
    if (!key || !value || !args[4] || !/^[a-f0-9]{64}$/i.test(normalizeFingerprint(value))) throw new Error("Usage: pi-cloud client pair <https-url> <fingerprint> <one-time-code>");
    const connection = new CloudConnection(key, value);
    const fingerprint = normalizeFingerprint(value);
    const existing = (await loadClientState()).connections.find((item) => item.baseUrl === connection.baseUrl);
    if (existing && existing.fingerprint !== fingerprint) throw new Error("Saved Worker certificate changed; verify its identity and explicitly unpair before connecting again");
    if (existing) {
      try {
        const worker = await new CloudConnection(existing.baseUrl, existing.fingerprint, existing.token).workerInfo();
        if (worker.workerId !== existing.workerId) throw new Error("WORKER_IDENTITY_MISMATCH");
        stdout(`already-paired=${worker.workerId}`);
        return 0;
      } catch (error) {
        if (error instanceof Error && ["CERTIFICATE_MISMATCH", "WORKER_IDENTITY_MISMATCH"].includes(error.message)) throw error;
        // Revoked or unreachable tokens do not authorize replacing the saved identity.
        throw new Error("Saved Worker connection failed; inspect or unpair it before pairing again");
      }
    }
    const paired = await connection.pair(args[4]);
    const worker = await connection.workerInfo();
    if (worker.workerId !== paired.workerId) throw new Error("WORKER_IDENTITY_MISMATCH");
    await updateClientState((state) => {
      if (state.connections.some((item) => item.workerId === paired.workerId && item.fingerprint !== fingerprint)) throw new Error("Saved Worker identity changed; unpair explicitly first");
      return { ...state, connections: [...state.connections.filter((item) => item.workerId !== paired.workerId), {
        baseUrl: connection.baseUrl, workerId: paired.workerId, fingerprint, token: paired.token, pairedAt: new Date().toISOString(),
      }], activeWorkerId: paired.workerId };
    });
    stdout(`paired=${paired.workerId}`);
    return 0;
  }
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
      await pairingOutput(config, tls.fingerprint, pairing, stdout);
      return tls;
    });
    if (command === "install") {
      stdout(`certificate=${tls.paths.certificate}`);
      if (args.includes("--systemd") || args.includes("--service")) {
        if (process.platform === "linux") stdout(`systemd-unit=${await writeSystemdUnit(config.dataDir, { docker: config.runner === "docker" })}`);
        else if (process.platform === "darwin") stdout(`launchd-plist=${await writeLaunchdPlist(config.dataDir)}`);
        else if (process.platform === "win32") {
          const script = await writeWindowsWorkerScript(config.dataDir);
          await execFileAsync("schtasks.exe", ["/Create", "/TN", WINDOWS_WORKER_TASK, "/TR", `\"${script}\"`, "/SC", "ONLOGON", "/F"], { windowsHide: true });
          stdout(`scheduled-task=${WINDOWS_WORKER_TASK}`);
          stdout(`worker-script=${script}`);
        }
      }
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
    const piVersionCommand = process.platform === "win32"
      ? execFileAsync(process.execPath, [fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))), "--version"])
      : execFileAsync("pi", ["--version"]);
    const [{ stdout: piVersion }, { stdout: gitVersion }] = await Promise.all([piVersionCommand, execFileAsync("git", ["--version"])]);
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
    try {
      await runWorkerService(command);
      stdout(`worker ${command}: ok`);
      return 0;
    } catch {
      stdout(`worker ${command}: failed`);
      return 1;
    }
  }
  stdout(usage);
  return 2;
}
