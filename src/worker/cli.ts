import { execFile } from "node:child_process";

import {
  loadWorkerConfig,
  saveWorkerConfig,
  setWorkerConfigValue,
} from "./config.js";
import { createPairing, revokeToken } from "./pairing.js";
import { loadWorkerState, saveWorkerState } from "./state.js";
import { ensureSelfSignedCertificate } from "./tls.js";
import { startWorkerServer } from "./server.js";
import { cleanupExpiredTasks, writeSystemdUnit } from "./service.js";
import { discoverWorkerAddresses } from "./network.js";

function pairingOutput(
  config: Awaited<ReturnType<typeof loadWorkerConfig>>,
  fingerprint: string,
  pairing: { code: string; expiresAt: string },
  stdout: (message: string) => void,
): void {
  const address = `https://${config.publicIp}:${config.port}`;
  stdout(`address=${address}`);
  stdout(`fingerprint=${fingerprint}`);
  stdout(`pairing-code=${pairing.code}`);
  stdout(`pairing-expires-at=${pairing.expiresAt}`);
  stdout(`pair-command=/cloud-pair ${address} ${fingerprint} ${pairing.code}`);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runWorkerCli(
  args: string[],
  stdout = console.log,
): Promise<number> {
  let config = await loadWorkerConfig();
  const [scope, command, key, value] = args;
  if (scope !== "worker" && scope !== "config") {
    stdout(
      "Usage: pi-cloud worker <install|pair|ips|status|tokens|start|stop> | config set <key> <value>",
    );
    return 2;
  }
  if (scope === "config" && command === "set" && key && value) {
    const next = setWorkerConfigValue(config, key, value);
    await saveWorkerConfig(next);
    stdout(`${key}=${value}`);
    return 0;
  }
  if (scope === "worker" && command === "ips") {
    stdout(JSON.stringify(await discoverWorkerAddresses(), null, 2));
    return 0;
  }
  if (scope === "worker" && command === "tokens") {
    const state = await loadWorkerState(config.dataDir);
    stdout(
      JSON.stringify(
        state.tokens.map(({ id, createdAt, revokedAt }) => ({
          id,
          createdAt,
          revokedAt: revokedAt ?? null,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (scope === "worker" && command === "token" && key === "revoke" && value) {
    const state = await loadWorkerState(config.dataDir);
    if (!revokeToken(state, value))
      throw new Error(`active token not found: ${value}`);
    await saveWorkerState(config.dataDir, state);
    stdout(`revoked-token=${value}`);
    return 0;
  }
  if (scope === "worker" && command === "pair") {
    const tls = await ensureSelfSignedCertificate(
      config.dataDir,
      config.publicIp,
    );
    const state = await loadWorkerState(config.dataDir);
    state.certificateFingerprint = tls.fingerprint;
    const pairing = createPairing(state);
    await saveWorkerState(config.dataDir, state);
    pairingOutput(config, tls.fingerprint, pairing, stdout);
    return 0;
  }
  if (scope === "worker" && command === "status") {
    const state = await loadWorkerState(config.dataDir);
    stdout(
      JSON.stringify(
        {
          workerId: state.workerId,
          address: `https://${config.publicIp}:${config.port}`,
          fingerprint: state.certificateFingerprint ?? null,
          locale: config.locale,
          runner: config.runner,
          activeTaskId: state.activeTaskId ?? null,
          pairingExpiresAt: state.pairingExpiresAt ?? null,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (scope === "worker" && command === "serve") {
    const worker = await startWorkerServer({
      dataDir: config.dataDir,
      publicIp: config.publicIp,
      piVersion: "0.84.2",
      nodeVersion: process.version,
      gitVersion: "unknown",
    });
    stdout(`listening=${worker.url}`);
    await new Promise<void>((resolve) => {
      const stop = () => {
        void worker.close().then(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }
  if (scope === "worker" && command === "cleanup") {
    if (config.retention !== "days" || !config.retentionDays) {
      stdout("retention=until-delete");
      return 0;
    }
    const removed = await cleanupExpiredTasks(
      config.dataDir,
      config.retentionDays,
    );
    stdout(JSON.stringify({ removed }));
    return 0;
  }
  if (scope === "worker" && command === "install") {
    const detected = await discoverWorkerAddresses();
    const configuredIp =
      config.publicIp === "127.0.0.1" ? undefined : config.publicIp;
    const ip =
      flagValue(args, "--ip") ??
      configuredIp ??
      detected.publicIp ??
      detected.privateIps[0];
    if (!ip) throw new Error("No Worker IP detected; pass --ip <address>");
    config = setWorkerConfigValue(config, "ip", ip);
    await saveWorkerConfig(config);
    const tls = await ensureSelfSignedCertificate(
      config.dataDir,
      config.publicIp,
    );
    const state = await loadWorkerState(config.dataDir);
    state.certificateFingerprint = tls.fingerprint;
    const pairing = createPairing(state);
    await saveWorkerState(config.dataDir, state);
    pairingOutput(config, tls.fingerprint, pairing, stdout);
    stdout(`certificate=${tls.paths.certificate}`);
    if (args.includes("--systemd"))
      stdout(`systemd-unit=${await writeSystemdUnit(config.dataDir)}`);
    return 0;
  }
  if (scope === "worker" && command === "tls" && key === "rotate") {
    const ip = flagValue(args, "--ip") ?? value ?? config.publicIp;
    config = setWorkerConfigValue(config, "ip", ip);
    await saveWorkerConfig(config);
    const tls = await ensureSelfSignedCertificate(
      config.dataDir,
      config.publicIp,
    );
    const state = await loadWorkerState(config.dataDir);
    state.certificateFingerprint = tls.fingerprint;
    const pairing = createPairing(state);
    await saveWorkerState(config.dataDir, state);
    pairingOutput(config, tls.fingerprint, pairing, stdout);
    return 0;
  }
  if (scope === "worker" && (command === "start" || command === "stop")) {
    await saveWorkerConfig(config);
    await loadWorkerState(config.dataDir);
    const exitCode = await new Promise<number>((resolve) =>
      execFile("systemctl", [command, "pi-cloud-worker.service"], (error) =>
        resolve(error ? 1 : 0),
      ),
    );
    stdout(`worker ${command}: ${exitCode === 0 ? "ok" : "failed"}`);
    return exitCode;
  }
  stdout(
    "Usage: pi-cloud worker <install|pair|ips|status|tokens|start|stop> | config set <key> <value>",
  );
  return 2;
}
