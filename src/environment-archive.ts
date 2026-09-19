import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  buildEnvironmentManifest,
  fingerprintSecret,
  sha256,
  walkFiles,
  type EnvironmentScanOptions,
} from "./environment.js";
import { decodeBase64, safeFilePath, validateRelativePath } from "./paths.js";
import type { EnvironmentManifest } from "./protocol.js";

export interface RuntimeFile {
  path: string;
  contentBase64: string;
  sha256: string;
  mode: "100644" | "100755";
}
export interface EnvironmentArchive {
  format: 1;
  manifest: EnvironmentManifest;
  files: RuntimeFile[];
  installPaths: string[];
}
export interface RuntimeCredentials {
  format: 1;
  files: RuntimeFile[];
  env: Record<string, string>;
}

const resourceKeys = ["extensions", "skills", "prompts", "themes"] as const;
const privateFiles =
  /^(?:auth|trust|cloud-state|pi-cloud|pi-cloud-state|telemetry|stats|history|models-cache)\.json$/;
const secretKey =
  /(?:api.?key|access.?key|(?:access|refresh)?token|password|secret|credentials?|authorization|headers)$/i;
const forbiddenEnv =
  /^(?:PATH|HOME|USERPROFILE|SHELL|COMSPEC|NODE_.*|LD_.*|DYLD_.*|PI_.*|NPM_CONFIG_.*|BASH_ENV|ENV)$/i;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

async function jsonValueFile(path: string): Promise<JsonValue> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as JsonValue;
  } catch {
    /* Report the filename, not a credential-bearing JSON excerpt. */
  }
  throw new Error(`invalid runtime configuration: ${basename(path)}`);
}

async function jsonFile(path: string): Promise<JsonObject> {
  const value = await jsonValueFile(path);
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new Error(`runtime configuration must be an object: ${basename(path)}`);
}

function runtimeFile(
  path: string,
  content: Buffer,
  executable = false,
): RuntimeFile {
  validateRelativePath(path);
  return {
    path,
    contentBase64: content.toString("base64"),
    sha256: sha256(content),
    mode: executable ? "100755" : "100644",
  };
}

function redacted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redacted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, entry]) =>
            !(
              secretKey.test(key) &&
              (typeof entry === "string" ||
                (entry && typeof entry === "object"))
            ),
        )
        .map(([key, entry]) => [key, redacted(entry)]),
    );
  if (typeof value === "string") {
    const url = URL.parse(value);
    if (
      url &&
      (url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) => secretKey.test(key)))
    ) {
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()])
        if (secretKey.test(key)) url.searchParams.delete(key);
      return url.toString();
    }
  }
  return value;
}

/** Configuration and credential payloads remain separate all the way to the upload choice. */
export async function scanEnvironment(
  options: EnvironmentScanOptions,
): Promise<{
  archive: EnvironmentArchive;
  credentials: RuntimeCredentials;
}> {
  const agentDir = resolve(options.agentDir);
  const manifest = await buildEnvironmentManifest(options);
  const files = new Map<string, RuntimeFile>();
  const credentials: RuntimeCredentials = { format: 1, files: [], env: {} };
  const secretFiles = new Map<string, RuntimeFile>();
  const installPaths = new Set<string>();
  let size = 0;
  const collectVariables = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(
        /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
      )) {
        const name = (match[1] ?? match[2])!;
        if (!forbiddenEnv.test(name) && process.env[name] !== undefined)
          credentials.env[name] = process.env[name]!;
      }
    } else if (value && typeof value === "object")
      for (const item of Object.values(value)) collectVariables(item);
  };
  const addBytes = (path: string, bytes: Buffer, executable: boolean): void => {
    size += bytes.length;
    if (size > 35 * 1024 * 1024)
      throw new Error(
        "Pi runtime resources exceed the 35 MiB upload limit; reduce enabled local resources",
      );
    files.set(path, runtimeFile(path, bytes, executable));
  };
  const addJson = (path: string, value: JsonValue): void => {
    collectVariables(value);
    const original = JSON.stringify(value);
    const sanitized = JSON.stringify(redacted(value));
    if (sanitized !== original)
      secretFiles.set(path, runtimeFile(path, Buffer.from(original)));
    addBytes(path, Buffer.from(sanitized), false);
  };
  const addFile = async (absolute: string, path: string): Promise<void> => {
    if (files.has(path) || privateFiles.test(basename(path))) return;
    const info = await lstat(absolute);
    if (!info.isFile())
      throw new Error(`runtime resource is not a regular file: ${absolute}`);
    if (
      path.endsWith(".json") &&
      !["package.json", "package-lock.json"].includes(basename(path))
    ) {
      addJson(path, await jsonValueFile(absolute));
    } else
      addBytes(
        path,
        await readFile(absolute),
        process.platform === "win32"
          ? path.endsWith(".sh")
          : !!(info.mode & 0o111),
      );
    if (basename(path) === "package.json") {
      const pkg = await jsonFile(absolute);
      if (pkg.dependencies && typeof pkg.dependencies === "object")
        installPaths.add(dirname(path).split(sep).join("/"));
    }
  };
  const copyDirectory = async (
    absolute: string,
    destination: string,
  ): Promise<void> => {
    for (const file of await walkFiles(absolute, true))
      await addFile(
        file,
        `${destination}/${relative(absolute, file).split(sep).join("/")}`,
      );
  };

  for (const resource of manifest.resources) {
    if (!resource.path.startsWith("global/")) continue; // Project resources are part of the selected Git workspace.
    const path = resource.path.slice(7);
    await addFile(join(agentDir, path), path);
  }
  for (const entry of await readdir(agentDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  )) {
    if (
      entry.isFile() &&
      /\.(?:json|md)$/.test(entry.name) &&
      !privateFiles.test(entry.name) &&
      !["settings.json", "models.json"].includes(entry.name)
    )
      await addFile(join(agentDir, entry.name), entry.name);
  }
  await copyDirectory(join(agentDir, "agents"), "agents");

  const copyReference = async (value: string): Promise<string> => {
    const sign = /^[!+-]/.test(value) ? value[0]! : "";
    const reference = value.slice(sign.length);
    const expanded =
      reference.startsWith("~/") || reference.startsWith("~\\")
        ? join(homedir(), reference.slice(2))
        : reference;
    const absolute = resolve(agentDir, expanded);
    const globIndex = absolute.search(/[*?{[]/);
    const prefix = globIndex >= 0 ? absolute.slice(0, globIndex) : absolute;
    const root =
      globIndex < 0
        ? absolute
        : /[/\\]$/.test(prefix)
          ? prefix.slice(0, -1)
          : dirname(prefix);
    let info;
    try {
      info = await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`configured Pi resource does not exist: ${reference}`);
    }
    if (info.isSymbolicLink())
      throw new Error(
        `configured Pi resource is a symlink; use its real package path: ${reference}`,
      );
    const withinAgent = relative(agentDir, root).split(sep).join("/");
    const local =
      withinAgent && !withinAgent.startsWith("../") && !isAbsolute(withinAgent);
    const target = local
      ? withinAgent
      : `resources/${sha256(root).slice(0, 16)}`;
    if (info.isDirectory()) {
      await copyDirectory(root, target);
      return `${sign}./${target}${globIndex >= 0 ? `/${relative(root, absolute).split(sep).join("/")}` : ""}`;
    }
    const destination = local ? withinAgent : `${target}/${basename(root)}`;
    if (!local)
      manifest.warnings.push({ code: "WARN_ABSOLUTE_PATH", path: reference });
    // ponytail: standalone external files cannot discover arbitrary sibling imports; use a package directory for those dependencies.
    await addFile(root, destination);
    return `${sign}./${destination}`;
  };
  const settings = await jsonFile(join(agentDir, "settings.json"));
  for (const key of resourceKeys) {
    if (Array.isArray(settings[key]))
      settings[key] = await Promise.all(
        (settings[key] as unknown[]).map(async (value) => {
          if (typeof value !== "string")
            throw new Error(`invalid Pi ${key} resource`);
          // Relative filters over auto-discovered directories keep their native meaning.
          if (/^[!+-]?(?:extensions|skills|prompts|themes)[/\\]/.test(value))
            return value.replaceAll("\\", "/");
          return copyReference(value);
        }),
      );
  }
  const packages: JsonValue[] = [];
  for (const item of Array.isArray(settings.packages)
    ? settings.packages
    : []) {
    const source =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && "source" in item
          ? item.source
          : undefined;
    if (typeof source !== "string")
      throw new Error("invalid Pi package declaration");
    if (/(?:^npm:|[/\\])pi-cloud-computing(?:@|[/\\]|$)/.test(source)) continue;
    const rewritten = /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(
      source,
    )
      ? source
      : await copyReference(source);
    if (typeof item === "string") packages.push(rewritten);
    else if (item && typeof item === "object" && !Array.isArray(item))
      packages.push({ ...item, source: rewritten });
  }
  settings.packages = packages;
  for (const key of [
    "sessionDir",
    "trackingId",
    "httpProxy",
    "npmCommand",
    "shellPath",
  ]) {
    if (settings[key] !== undefined)
      manifest.warnings.push({ code: "WARN_ABSOLUTE_PATH", path: key });
    delete settings[key];
  }
  settings.enableInstallTelemetry = false;
  settings.enableAnalytics = false;
  addJson("settings.json", settings);
  addJson("models.json", await jsonFile(join(agentDir, "models.json")));
  const auth = await jsonFile(join(agentDir, "auth.json"));
  if (Object.keys(auth).length) {
    collectVariables(auth);
    secretFiles.set(
      "auth.json",
      runtimeFile("auth.json", Buffer.from(JSON.stringify(auth))),
    );
  }
  // Resource metadata describes the actual redacted upload, not the local secret-bearing files.
  manifest.resources = [...files.values()].map((file) => ({
    kind: file.path.startsWith("extensions/")
      ? "extension"
      : file.path.startsWith("skills/")
        ? "skill"
        : file.path.startsWith("themes/")
          ? "theme"
          : "prompt",
    path: `global/${file.path}`,
    sha256: file.sha256,
  }));
  manifest.packages = (
    (redacted(settings) as JsonObject).packages as JsonValue[]
  ).map((item) => {
    if (typeof item === "string") return { source: item, enabled: true };
    const config = item as JsonObject;
    return {
      source: String(config.source),
      enabled: config.autoload !== false,
    };
  });
  credentials.files = [...secretFiles.values()];
  if (credentials.files.length || Object.keys(credentials.env).length)
    manifest.secretVersions.push(
      fingerprintSecret("pi-runtime", 1, JSON.stringify(credentials), false),
    );
  return {
    archive: {
      format: 1,
      manifest,
      files: [...files.values()],
      installPaths: [...installPaths],
    },
    credentials,
  };
}

function validateFiles(files: unknown): asserts files is RuntimeFile[] {
  if (!Array.isArray(files)) throw new Error("invalid environment files");
  const paths = new Set<string>();
  for (const file of files) {
    if (!file || typeof file !== "object")
      throw new Error("invalid environment file");
    validateRelativePath(file.path);
    if (paths.has(file.path)) throw new Error("duplicate environment file");
    paths.add(file.path);
    if (file.mode !== "100644" && file.mode !== "100755")
      throw new Error("invalid runtime file mode");
    if (sha256(decodeBase64(file.contentBase64)) !== file.sha256)
      throw new Error("runtime file hash mismatch");
  }
}

export function parseEnvironmentArchive(value: string): EnvironmentArchive {
  let archive: EnvironmentArchive;
  try {
    archive = JSON.parse(value) as EnvironmentArchive;
  } catch {
    throw new Error("invalid environment archive JSON");
  }
  if (
    !archive ||
    archive.format !== 1 ||
    !archive.manifest ||
    !Array.isArray(archive.installPaths)
  )
    throw new Error(
      "invalid environment archive; update both client and Worker",
    );
  validateFiles(archive.files);
  for (const path of archive.installPaths) {
    if (path !== ".") validateRelativePath(path);
    if (
      !archive.files.some(
        (file) =>
          file.path ===
          (path === "." ? "package.json" : `${path}/package.json`),
      )
    )
      throw new Error("runtime dependency path has no package manifest");
  }
  if (archive.files.some((file) => privateFiles.test(file.path)))
    throw new Error("credentials may not be uploaded as environment files");
  return archive;
}

export async function materializeEnvironment(
  archive: EnvironmentArchive,
  agentDir: string,
): Promise<void> {
  validateFiles(archive.files);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const file of archive.files) {
    const path = await safeFilePath(agentDir, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, decodeBase64(file.contentBase64), {
      mode: file.mode === "100755" ? 0o700 : 0o600,
    });
    if (process.platform !== "win32")
      await chmod(path, file.mode === "100755" ? 0o700 : 0o600);
  }
}

export async function materializeCredentials(
  value: string,
  agentDir: string,
  archive?: EnvironmentArchive,
): Promise<Record<string, string>> {
  let credentials: RuntimeCredentials;
  try {
    credentials = JSON.parse(value) as RuntimeCredentials;
  } catch {
    throw new Error("invalid runtime credentials");
  }
  if (
    !credentials ||
    credentials.format !== 1 ||
    !credentials.env ||
    typeof credentials.env !== "object" ||
    Array.isArray(credentials.env)
  )
    throw new Error("invalid runtime credentials");
  validateFiles(credentials.files);
  for (const [name, secret] of Object.entries(credentials.env)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      forbiddenEnv.test(name) ||
      typeof secret !== "string"
    )
      throw new Error("invalid runtime environment variable");
  }
  const permitted = new Set([
    "auth.json",
    ...(archive?.files.map((file) => file.path) ?? []),
  ]);
  await materializeEnvironment(
    {
      format: 1,
      files: credentials.files.filter((file) => permitted.has(file.path)),
      manifest: archive?.manifest ?? ({} as EnvironmentManifest),
      installPaths: [],
    },
    agentDir,
  );
  return credentials.env;
}
