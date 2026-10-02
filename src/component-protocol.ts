import { stripVTControlCharacters } from "node:util";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";

export interface ToolPresentation { toolCallId: string; width: number; expanded: boolean; lines: string[] }
export interface ToolViewRequest { toolCallId: string; width: number; expanded: boolean }
export function parseToolViewRequest(value: unknown): ToolViewRequest {
  const view = object(value);
  if (typeof view.toolCallId !== "string" || !view.toolCallId || view.toolCallId.length > 200 || /[\x00-\x1f]/.test(view.toolCallId) || typeof view.expanded !== "boolean") throw new Error("INVALID_TOOL_VIEW");
  return { toolCallId: view.toolCallId, width: integer(view.width, 10, 500), expanded: view.expanded };
}
export function parseToolPresentation(value: unknown): ToolPresentation {
  const view = object(value), request = parseToolViewRequest(value);
  const frame = parseComponentFrame({ type: "frame", id: "tool", revision: 1, width: request.width, lines: view.lines });
  if (frame.type !== "frame") throw new Error("INVALID_TOOL_VIEW");
  return { ...request, lines: frame.lines };
}

export type ComponentFrame =
  | { type: "open"; id: string }
  | { type: "frame"; id: string; revision: number; width: number; lines: string[] }
  | { type: "close"; id: string };
export type ComponentInput =
  | { type: "input"; id: string; data: string }
  | { type: "resize"; id: string; width: number; height: number }
  | { type: "mouse"; id: string; event: TuiMouseEvent }
  | { type: "cancel"; id: string };

/** Allow SGR and Pi's scoped caret marker, never cursor commands or clipboard/title OSC. */
export function safeComponentLine(line: string): string {
  line = line.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "");
  return line.split(/(\x1b_pi:c\x07|\x1b\[[0-9;:]{0,80}m)/g).map(part =>
    /^(?:\x1b_pi:c\x07|\x1b\[[0-9;:]{0,80}m)$/.test(part) ? part
      : stripVTControlCharacters(part).replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
  ).join("");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_COMPONENT_FRAME");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error("INVALID_COMPONENT_ID");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("INVALID_COMPONENT_DIMENSION");
  return value;
}
export function parseComponentFrame(value: unknown): ComponentFrame {
  const frame = object(value), componentId = id(frame.id);
  if (frame.type === "open" || frame.type === "close") return { type: frame.type, id: componentId };
  if (frame.type !== "frame" || !Array.isArray(frame.lines) || frame.lines.length > 500) throw new Error("INVALID_COMPONENT_FRAME");
  const lines = frame.lines.map(line => {
    if (typeof line !== "string" || line.length > 16_384 || safeComponentLine(line) !== line) throw new Error("INVALID_COMPONENT_LINE");
    return line;
  });
  if (Buffer.byteLength(JSON.stringify(lines)) > 128 * 1024) throw new Error("COMPONENT_FRAME_TOO_LARGE");
  return { type: "frame", id: componentId, revision: integer(frame.revision, 1, Number.MAX_SAFE_INTEGER), width: integer(frame.width, 10, 500), lines };
}
export function parseComponentInput(value: unknown): ComponentInput {
  const input = object(value), componentId = id(input.id);
  if (input.type === "cancel") return { type: "cancel", id: componentId };
  if (input.type === "resize") return { type: "resize", id: componentId, width: integer(input.width, 10, 500), height: integer(input.height, 1, 500) };
  if (input.type === "input") {
    if (typeof input.data !== "string" || Buffer.byteLength(input.data) > 64 * 1024) throw new Error("INVALID_COMPONENT_INPUT");
    return { type: "input", id: componentId, data: input.data };
  }
  if (input.type !== "mouse") throw new Error("INVALID_COMPONENT_INPUT");
  const event = object(input.event);
  if (!["press", "release", "move", "drag", "click", "wheel"].includes(String(event.type)) || !["left", "middle", "right", "none"].includes(String(event.button))) throw new Error("INVALID_COMPONENT_MOUSE");
  for (const key of ["shift", "alt", "ctrl"]) if (typeof event[key] !== "boolean") throw new Error("INVALID_COMPONENT_MOUSE");
  const mouse: TuiMouseEvent = {
    type: event.type as TuiMouseEvent["type"], button: event.button as TuiMouseEvent["button"],
    x: integer(event.x, -500, 500), y: integer(event.y, -500, 500),
    screenX: integer(event.screenX, 0, 4096), screenY: integer(event.screenY, 0, 4096),
    width: integer(event.width, 1, 500), height: integer(event.height, 1, 500),
    shift: event.shift as boolean, alt: event.alt as boolean, ctrl: event.ctrl as boolean,
    ...(event.wheelDelta !== undefined ? { wheelDelta: integer(event.wheelDelta, -1000, 1000) } : {}),
    ...(event.clickCount !== undefined ? { clickCount: integer(event.clickCount, 1, 100) } : {}),
  };
  return { type: "mouse", id: componentId, event: mouse };
}
