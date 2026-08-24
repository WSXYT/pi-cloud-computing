import type { Locale } from "./protocol.js";

export const MESSAGE_KEYS = [
  "language.set",
  "language.fallback",
  "pair.certificateUntrusted",
  "pair.certificatePinned",
  "pair.codeExpired",
  "task.submitted",
  "task.running",
  "task.completed",
  "task.aborted",
  "task.platformWarning",
  "result.ready",
  "result.baseMismatch",
  "recommendation.sponsorPlaceholder",
  "recommendation.relayPlaceholder",
  "cloud.pairDescription",
  "cloud.unpairDescription",
  "cloud.submitDescription",
  "cloud.abortDescription",
  "cloud.menu",
  "cloud.submitChoice",
  "cloud.pairChoice",
  "cloud.abortChoice",
  "cloud.unpairChoice",
  "cloud.noWorker",
  "cloud.noTask",
  "cloud.cancelled",
  "cloud.started",
  "cloud.abortRequested",
  "cloud.pairUsage",
  "cloud.paired",
  "cloud.unpaired",
  "cloud.taskActive",
  "cloud.remotePrompt",
  "cloud.syncConfirm",
  "cloud.reconnectDescription",
  "cloud.reconnected",
  "cloud.mergeDescription",
  "cloud.mergeUsage",
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];
export type MessageParams = Record<string, string | number>;

type Catalog = Record<MessageKey, string>;

const zhCN: Catalog = {
  "language.set": "语言已设置为 {locale}",
  "language.fallback": "不支持语言 {locale}，已回退到 English",
  "pair.certificateUntrusted": "检测到未信任的自签名证书",
  "pair.certificatePinned": "配对成功，证书已固定",
  "pair.codeExpired": "配对码已过期，请在服务器上生成新的配对码",
  "task.submitted": "任务已提交到 {address}",
  "task.running": "云端任务运行中",
  "task.completed": "云端任务已完成",
  "task.aborted": "云端任务已中止",
  "task.platformWarning": "平台差异可能导致 {path} 在服务器上不可用",
  "result.ready": "结果已准备好，可以查看或应用",
  "result.baseMismatch": "本地基线已变化，未应用远端结果",
  "recommendation.sponsorPlaceholder": "赞助商推荐位（待配置）",
  "recommendation.relayPlaceholder": "中转站推荐位（待配置）",
  "cloud.pairDescription": "将此 Pi 与自托管 Pi Cloud Worker 配对",
  "cloud.unpairDescription": "移除已保存的本地连接",
  "cloud.submitDescription": "在已配对 Worker 上运行当前 Pi 会话",
  "cloud.abortDescription": "中止当前云端任务",
  "cloud.menu": "Pi Cloud",
  "cloud.submitChoice": "提交当前会话",
  "cloud.pairChoice": "配对 Worker",
  "cloud.abortChoice": "中止当前任务",
  "cloud.unpairChoice": "解除 Worker 配对",
  "cloud.noWorker": "没有已配对的 Worker",
  "cloud.noTask": "没有活动的云端任务",
  "cloud.cancelled": "已取消云端提交",
  "cloud.started": "云端任务已启动：{taskId}",
  "cloud.abortRequested": "已请求中止云端任务",
  "cloud.pairUsage":
    "用法：/cloud-pair <https-url> <sha256-fingerprint> <pairing-code>",
  "cloud.paired": "已与 Worker {workerId} 配对",
  "cloud.unpaired": "本地配对已移除；如需彻底失效，请在 Worker 上撤销 token",
  "cloud.taskActive": "云端任务 {taskId} 已在运行",
  "cloud.remotePrompt": "云端提示词",
  "cloud.syncConfirm": "确认云端同步",
  "cloud.reconnectDescription": "恢复云端任务的事件连接",
  "cloud.reconnected": "云端任务连接已恢复",
  "cloud.mergeDescription": "将云端原生 session 合并回当前会话",
  "cloud.mergeUsage": "用法：/cloud-merge <session-artifact-id>",
};

const en: Catalog = {
  "language.set": "Language set to {locale}",
  "language.fallback": "Unsupported language {locale}; falling back to English",
  "pair.certificateUntrusted": "Untrusted self-signed certificate detected",
  "pair.certificatePinned": "Paired successfully; certificate pinned",
  "pair.codeExpired": "Pairing code expired; generate a new code on the server",
  "task.submitted": "Task submitted to {address}",
  "task.running": "Cloud task is running",
  "task.completed": "Cloud task completed",
  "task.aborted": "Cloud task aborted",
  "task.platformWarning":
    "Platform differences may make {path} unavailable on the server",
  "result.ready": "Result is ready to review or apply",
  "result.baseMismatch": "Local base changed; remote result was not applied",
  "recommendation.sponsorPlaceholder": "Sponsor recommendation placeholder",
  "recommendation.relayPlaceholder": "Relay-service recommendation placeholder",
  "cloud.pairDescription": "Pair this Pi with a self-hosted Pi Cloud Worker",
  "cloud.unpairDescription": "Remove the stored local connection",
  "cloud.submitDescription": "Run the current Pi session on a paired Worker",
  "cloud.abortDescription": "Abort the active remote task",
  "cloud.menu": "Pi Cloud",
  "cloud.submitChoice": "Submit current session",
  "cloud.pairChoice": "Pair Worker",
  "cloud.abortChoice": "Abort active task",
  "cloud.unpairChoice": "Unpair Worker",
  "cloud.noWorker": "No paired Worker",
  "cloud.noTask": "No active cloud task",
  "cloud.cancelled": "Cloud submission cancelled",
  "cloud.started": "Cloud task started: {taskId}",
  "cloud.abortRequested": "Remote task abort requested",
  "cloud.pairUsage":
    "Usage: /cloud-pair <https-url> <sha256-fingerprint> <pairing-code>",
  "cloud.paired": "Paired with Worker {workerId}",
  "cloud.unpaired":
    "Local pairing removed; revoke the token on the Worker if needed",
  "cloud.taskActive": "Cloud task {taskId} is already active",
  "cloud.remotePrompt": "Remote prompt",
  "cloud.syncConfirm": "Confirm cloud sync",
  "cloud.reconnectDescription": "Reconnect the remote task event stream",
  "cloud.reconnected": "Remote task connection restored",
  "cloud.mergeDescription":
    "Merge the remote native session back into this session",
  "cloud.mergeUsage": "Usage: /cloud-merge <session-artifact-id>",
};

export const catalogs: Record<Locale, Catalog> = { "zh-CN": zhCN, en };

export function resolveLocale(value?: string): Locale {
  const normalized = (value ?? "").trim().toLowerCase().replace("_", "-");
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return "en";
}

export function detectLocale(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Locale {
  if (explicit) return resolveLocale(explicit);
  return resolveLocale(
    env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? env.LANGUAGE,
  );
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params: MessageParams = {},
): string {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(params[name] ?? `{${name}}`),
  );
}
