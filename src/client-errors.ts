import { formatSize } from "@earendil-works/pi-coding-agent";
import { CloudRequestError } from "./client-network.js";
import { safeDisplayText } from "./client-events.js";
import { translate } from "./i18n.js";
import type { Locale, ProtocolError } from "./protocol.js";

export function formatCloudError(error: unknown, locale: Locale): string {
  if (error instanceof CloudRequestError) {
    const p = error.progress;
    const text = translate(locale, "cloud.transferFailure", { code: error.code,
      operation: translate(locale, `cloud.request.${p.operation}`), phase: translate(locale, `cloud.phase.${p.phase}`),
      sent: formatSize(p.sentBytes), total: formatSize(p.totalBytes), received: formatSize(p.receivedBytes), seconds: Math.ceil(p.elapsedMs / 1000) });
    return error.code === "WORKER_STORAGE_ERROR" ? `${text}\n${translate(locale, "cloud.storageFailure", { cause: error.serverCause ?? "STATE_WRITE_FAILED" })}` : text;
  }
  return safeDisplayText(error instanceof Error ? error.message : String(error));
}

export function formatProtocolError(error: ProtocolError, locale: Locale): string {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "INTERNAL_ERROR";
  if (code === "WORKER_STORAGE_ERROR") {
    const value = String(error.params?.cause ?? "STATE_WRITE_FAILED");
    return translate(locale, "cloud.storageFailure", { cause: /^[A-Z_]{1,32}$/.test(value) ? value : "STATE_WRITE_FAILED" });
  }
  return translate(locale, "cloud.protocolFailure", { code });
}
