import type { RuntimeCredentials } from "./environment-archive.js";

// Pi 0.85.1's API-key environment names. Only explicit, portable values are
// eligible: never copy machine-local ADC files, AWS profiles or metadata URLs.
const providerEnv: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"], anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"], "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"], "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"],
  "ant-ling": ["ANT_LING_API_KEY"], "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"], "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"], "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"], deepseek: ["DEEPSEEK_API_KEY"], groq: ["GROQ_API_KEY"], cerebras: ["CEREBRAS_API_KEY"], xai: ["XAI_API_KEY"], radius: ["RADIUS_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"], "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"], zai: ["ZAI_API_KEY"], "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"], mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"], "minimax-cn": ["MINIMAX_CN_API_KEY"], moonshotai: ["MOONSHOT_API_KEY"], "moonshotai-cn": ["MOONSHOT_API_KEY"], huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"], together: ["TOGETHER_API_KEY"], baseten: ["BASETEN_API_KEY"], opencode: ["OPENCODE_API_KEY"], "opencode-go": ["OPENCODE_API_KEY"], "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"], "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"], xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};

export function providerCredentialEnv(provider: string | undefined, env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries((providerEnv[provider ?? ""] ?? []).flatMap(name => {
    const value = env[name];
    return typeof value === "string" && value.trim() ? [[name, value]] : [];
  }));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only inspect the already-built consent bundle; never resolve shell commands or fetch credentials. */
export function hasProviderCredentials(bundle: RuntimeCredentials, provider: string | undefined, modelId?: string): boolean {
  if (!provider) return false;
  const env = providerCredentialEnv(provider, bundle.env);
  if (provider === "amazon-bedrock") {
    if (env.AWS_BEARER_TOKEN_BEDROCK || (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) return true;
  } else if (Object.keys(env).length) return true;
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
