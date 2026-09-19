import { readFile } from "node:fs/promises";
import { writePrivateJson } from "../storage.js";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";

import { detectLocale } from "../i18n.js";
import type { Locale, RunnerMode } from "../protocol.js";

export interface WorkerConfig {
  dataDir: string;
  host: string;
  publicIp: string;
  port: number;
  locale: Locale;
  runner: RunnerMode;
  dockerNetwork: "none" | "bridge";
  retention: "until-delete" | "days";
  retentionDays?: number;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CLOUD_DATA_DIR ?? join(homedir(), ".pi-cloud");
}

export function defaultWorkerConfig(dataDir = defaultDataDir()): WorkerConfig {
  return {
    dataDir,
    host: "0.0.0.0",
    publicIp: envPublicIp(),
    port: 9443,
    locale: detectLocale(),
    runner: process.env.PI_CLOUD_RUNNER === "host" ? "host" : "docker",
    dockerNetwork:
      process.env.PI_CLOUD_DOCKER_NETWORK === "bridge" ? "bridge" : "none",
    retention: "until-delete",
  };
}

function envPublicIp(): string {
  return process.env.PI_CLOUD_PUBLIC_IP ?? "127.0.0.1";
}

function parseConfig(value: unknown, dataDir: string): WorkerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid Worker configuration");
  const input = value as Record<string, unknown>;
  const port =
    typeof input.port === "number" &&
    Number.isInteger(input.port) &&
    input.port > 0 &&
    input.port < 65536
      ? input.port
      : 9443;
  const runner = input.runner === "host" ? "host" : "docker";
  const retention = input.retention === "days" ? "days" : "until-delete";
  const retentionDays =
    typeof input.retentionDays === "number" && input.retentionDays > 0
      ? input.retentionDays
      : undefined;
  return {
    dataDir,
    host:
      typeof input.host === "string" && input.host.length > 0
        ? input.host
        : "0.0.0.0",
    publicIp:
      typeof input.publicIp === "string" && isIP(input.publicIp) > 0
        ? input.publicIp
        : envPublicIp(),
    port,
    locale: detectLocale(
      typeof input.locale === "string" ? input.locale : undefined,
    ),
    runner,
    dockerNetwork: input.dockerNetwork === "bridge" ? "bridge" : "none",
    retention,
    ...(retentionDays === undefined ? {} : { retentionDays }),
  };
}

export async function loadWorkerConfig(
  dataDir = defaultDataDir(),
): Promise<WorkerConfig> {
  try {
    return parseConfig(
      JSON.parse((await readFile(join(dataDir, "config.json"), "utf8")).replace(/^\uFEFF/, "")),
      dataDir,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultWorkerConfig(dataDir);
    throw error;
  }
}

export async function saveWorkerConfig(config: WorkerConfig): Promise<void> {
  await writePrivateJson(join(config.dataDir, "config.json"), config);
}

export function setWorkerConfigValue(
  config: WorkerConfig,
  key: string,
  value: string,
): WorkerConfig {
  if (key === "language" || key === "locale")
    return { ...config, locale: detectLocale(value) };
  if (key === "ip" || key === "public-ip") {
    if (isIP(value) === 0)
      throw new Error("ip must be an IPv4 or IPv6 address");
    return { ...config, publicIp: value };
  }
  if (key === "port") {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("port must be between 1 and 65535");
    return { ...config, port };
  }
  if (key === "runner") {
    if (value !== "docker" && value !== "host")
      throw new Error("runner must be docker or host");
    return { ...config, runner: value };
  }
  if (key === "docker-network") {
    if (value !== "none" && value !== "bridge")
      throw new Error("docker-network must be none or bridge");
    return { ...config, dockerNetwork: value };
  }
  if (key === "retention") {
    if (value !== "until-delete" && value !== "days")
      throw new Error("retention must be until-delete or days");
    return { ...config, retention: value };
  }
  if (key === "retention-days") {
    const days = Number(value);
    if (!Number.isFinite(days) || days <= 0)
      throw new Error("retention-days must be positive");
    return { ...config, retention: "days", retentionDays: days };
  }
  throw new Error(`unknown config key: ${key}`);
}

export function defaultTempDataDir(): string {
  return join(tmpdir(), "pi-cloud");
}
