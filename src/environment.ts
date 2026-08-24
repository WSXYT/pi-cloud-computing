import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import type { EnvironmentManifest } from "./protocol.js";

const RESOURCE_DIRS = [
  ["extension", "extensions"],
  ["skill", "skills"],
  ["prompt", "prompts"],
  ["theme", "themes"],
] as const;

type ResourceKind = (typeof RESOURCE_DIRS)[number][0];

export interface EnvironmentScanOptions {
  agentDir: string;
  cwd: string;
  piVersion: string;
  nodeVersion?: string;
  platform?: string;
  secretVersions?: Array<{
    id: string;
    version: number;
    value?: string;
    authorized: boolean;
  }>;
}

export interface SecretFingerprint {
  id: string;
  version: number;
  sha256: string;
  authorized: boolean;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintSecret(
  id: string,
  version: number,
  value: string,
  authorized = true,
): SecretFingerprint {
  return {
    id,
    version,
    sha256: sha256(`${id}\0${version}\0${value}`),
    authorized,
  };
}

async function fileHash(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function walkFiles(
  root: string,
  includeHidden = false,
): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === "sessions" ||
        (!includeHidden && entry.name.startsWith("."))
      )
        continue;
      const path = join(root, entry.name);
      if (entry.isDirectory())
        files.push(...(await walkFiles(path, includeHidden)));
      else if (entry.isFile()) files.push(path);
    }
    return files;
  } catch {
    return [];
  }
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function packageSource(
  value: unknown,
): { source: string; version?: string; enabled: boolean } | null {
  if (typeof value === "string") return { source: value, enabled: true };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const item = value as Record<string, unknown>;
  if (typeof item.source !== "string") return null;
  return {
    source: item.source,
    ...(typeof item.version === "string" ? { version: item.version } : {}),
    enabled: item.autoload !== false,
  };
}

function compatibilityWarnings(
  path: string,
  platform: string,
): EnvironmentManifest["warnings"] {
  const warnings: EnvironmentManifest["warnings"] = [];
  if (platform === "linux" && /^[A-Za-z]:[\\/]/.test(path)) {
    warnings.push({ code: "WARN_ABSOLUTE_PATH", path });
  }
  if (/(node_modules|\.node$|\.dll$|\.dylib$|\.so$)/i.test(path)) {
    warnings.push({ code: "WARN_NATIVE_DEPENDENCY", path });
  }
  if (platform !== "win32" && /\\/.test(path)) {
    warnings.push({ code: "WARN_PLUGIN_PLATFORM_MISMATCH", path });
  }
  return warnings;
}

export async function buildEnvironmentManifest(
  options: EnvironmentScanOptions,
): Promise<EnvironmentManifest> {
  const agentDir = resolve(options.agentDir);
  const cwd = resolve(options.cwd);
  const platform = options.platform ?? process.platform;
  const settings = await readJson(join(agentDir, "settings.json"));
  const models = await readJson(join(agentDir, "models.json"));
  const rawPackages = Array.isArray(settings.packages) ? settings.packages : [];
  const packages = rawPackages
    .map(packageSource)
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const resources: EnvironmentManifest["resources"] = [];
  const warnings: EnvironmentManifest["warnings"] = [];

  for (const [kind, directory] of RESOURCE_DIRS) {
    for (const path of await walkFiles(join(agentDir, directory))) {
      resources.push({
        kind: kind as ResourceKind,
        path: `global/${relativePath(agentDir, path)}`,
        sha256: await fileHash(path),
      });
      warnings.push(...compatibilityWarnings(path, platform));
    }
  }

  const projectPi = join(cwd, ".pi");
  for (const path of await walkFiles(projectPi, true)) {
    resources.push({
      kind: "prompt",
      path: `project/${relativePath(cwd, path)}`,
      sha256: await fileHash(path),
    });
    warnings.push(...compatibilityWarnings(path, platform));
  }

  const providers = Object.entries(models).map(([id, value]) => ({
    id,
    models:
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Array.isArray((value as Record<string, unknown>).models)
        ? ((value as Record<string, unknown>).models as unknown[]).filter(
            (model): model is string => typeof model === "string",
          )
        : [],
    configSha256: sha256(JSON.stringify(value)),
  }));
  const secretVersions = (options.secretVersions ?? []).map(
    ({ id, version, value, authorized }) =>
      value === undefined
        ? { id, version, sha256: "", authorized }
        : fingerprintSecret(id, version, value, authorized),
  );

  return {
    piVersion: options.piVersion,
    nodeVersion: options.nodeVersion ?? process.version,
    platform,
    packages,
    resources,
    providers,
    secretVersions,
    warnings: [
      ...new Map(
        warnings.map((warning) => [
          `${warning.code}:${warning.path ?? ""}`,
          warning,
        ]),
      ).values(),
    ],
  };
}

export async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function secretValueIsChanged(
  previous: SecretFingerprint | undefined,
  current: SecretFingerprint,
): boolean {
  return (
    previous?.sha256 !== current.sha256 || previous.version !== current.version
  );
}

export function resourceAbsolutePath(
  agentDir: string,
  cwd: string,
  manifestPath: string,
): string {
  if (manifestPath.startsWith("global/"))
    return resolve(agentDir, manifestPath.slice("global/".length));
  if (manifestPath.startsWith("project/"))
    return resolve(cwd, manifestPath.slice("project/".length));
  return resolve(cwd, basename(manifestPath));
}
