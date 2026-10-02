import type { RuntimeCredentials } from "./environment-archive.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only inspect the already-built consent bundle; never resolve shell commands or fetch credentials. */
export function hasProviderCredentials(bundle: RuntimeCredentials, provider: string | undefined, modelId?: string): boolean {
  if (!provider) return false;
  const usable = (value: unknown, env: Record<string, unknown> = bundle.env): boolean => {
    if (typeof value !== "string" || !value.trim() || value.startsWith("!")) return false;
    // Pi escapes literal dollars/exclamation marks before interpolating explicit variables.
    const refs = [...value.replace(/\$[$!]/g, "").matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)];
    return refs.every(match => { const value = env[(match[1] ?? match[2])!]; return typeof value === "string" && value.length > 0; });
  };
  for (const file of bundle.files) {
    if (file.path !== "auth.json" && file.path !== "models.json") continue;
    let parsed: Record<string, unknown> | undefined;
    try { parsed = object(JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"))); }
    catch { continue; }
    if (file.path === "auth.json") {
      const auth = object(parsed?.[provider]);
      if (auth?.type === "api_key" && usable(auth.key, { ...bundle.env, ...object(auth.env) })) return true;
      if (auth?.type === "oauth" && (usable(auth.access) || usable(auth.refresh))) return true;
    } else {
      const config = object(object(parsed?.providers)?.[provider]);
      if (usable(config?.apiKey)) return true;
      const model = Array.isArray(config?.models) ? config.models.map(object).find(item => item?.id === modelId) : undefined;
      const headers = { ...object(config?.headers), ...object(model?.headers) };
      if (Object.entries(headers).some(([key, value]) => /^(?:authorization|(?:x-)?api[-_]?key)$/i.test(key) && usable(value))) return true;
    }
  }
  return false;
}
