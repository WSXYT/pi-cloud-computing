import { stripVTControlCharacters } from "node:util";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { TaskEvent } from "./protocol.js";

export function safeDisplayText(value: string): string {
  const result = truncateTail(stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, ""), { maxBytes: 50_000, maxLines: 1999 });
  return result.truncated ? `…\n${result.content}` : result.content;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((value) => {
    const block = record(value);
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "toolCall") return `→ ${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`;
    if (block?.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

export interface RemoteEventView {
  text?: string;
  delta?: string;
  reset?: boolean;
  transcript?: string;
}

/** Pi RPC data lives under payload.rpc, not at payload.text. Never execute terminal control sequences from it. */
export function remoteEventView(event: TaskEvent): RemoteEventView {
  const rpc = record(event.payload.rpc);
  if (!rpc) {
    const text = event.payload.message ?? event.payload.text;
    return typeof text === "string" ? { text: safeDisplayText(text), ...(event.kind === "message" ? { transcript: `› ${safeDisplayText(text)}` } : {}) } : {};
  }
  const message = record(rpc.message);
  if (rpc.type === "message_start" && message?.role === "assistant") return { reset: true };
  if (rpc.type === "message_update") {
    const text = contentText(message?.content);
    if (text) return { text: safeDisplayText(text) };
    const delta = record(rpc.assistantMessageEvent);
    return delta?.type === "text_delta" && typeof delta.delta === "string" ? { delta: safeDisplayText(delta.delta) } : {};
  }
  if (rpc.type === "message_end" && message?.role === "assistant") {
    const text = safeDisplayText(contentText(message.content) || String(message.errorMessage ?? ""));
    return text ? { text, transcript: text } : {};
  }
  if (rpc.type === "tool_execution_start") return { text: safeDisplayText(`→ ${String(rpc.toolName)} ${JSON.stringify(rpc.args ?? {})}`) };
  if (rpc.type === "tool_execution_update" || rpc.type === "tool_execution_end") {
    const result = record(rpc.result ?? rpc.partialResult);
    const text = safeDisplayText(`${rpc.isError ? "✗" : "→"} ${String(rpc.toolName)}\n${contentText(result?.content)}`);
    return { text, ...(rpc.type === "tool_execution_end" ? { transcript: text } : {}) };
  }
  if (rpc.type === "extension_ui_request" && rpc.method === "notify" && typeof rpc.message === "string") {
    const text = safeDisplayText(rpc.message);
    return { text, transcript: text };
  }
  if ((rpc.type === "response" && rpc.success === false) || rpc.type === "extension_error") {
    const text = safeDisplayText(String(rpc.error ?? rpc.message ?? "Remote extension error"));
    return { text, transcript: text };
  }
  return {};
}
