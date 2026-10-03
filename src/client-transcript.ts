import {
  AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createPowerShellToolDefinition, createGrepToolDefinition,
  createFindToolDefinition, createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { parseToolPresentation, type ToolPresentation, type ToolViewRequest } from "./component-protocol.js";
import { safeDisplayText } from "./client-events.js";
import type { TaskEvent } from "./protocol.js";

type Assistant = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type ToolRenderer = ConstructorParameters<typeof ToolExecutionComponent>[4];
type DisplayJson = string | number | boolean | null | DisplayJson[] | { [key: string]: DisplayJson };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Strip terminal instructions from display data, not from the authoritative remote session. */
function displayValue(value: unknown, depth = 0): DisplayJson {
  if (depth > 16) return "[nested display data omitted]";
  if (typeof value === "string") return safeDisplayText(value);
  if (Array.isArray(value)) return value.map(item => displayValue(item, depth + 1));
  const object = record(value);
  if (!object) return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value : null;
  if (object.type === "image") {
    const data = object.data;
    const mimeType = object.mimeType;
    if (typeof data !== "string" || data.length > 7 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || typeof mimeType !== "string" ||
      !/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) {
      return { type: "text", text: "[Unsupported image]" };
    }
    return { type: "image", data, mimeType };
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, displayValue(item, depth + 1)]));
}

function assistant(value: unknown): Assistant | undefined {
  const message = record(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  if (!message.content.every(item => {
    const block = record(item);
    return block && ((block.type === "text" && typeof block.text === "string") ||
      (block.type === "thinking" && typeof block.thinking === "string") ||
      (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string"));
  })) return undefined;
  const content: Assistant["content"] = message.content.map(item => {
    const block = record(item)!;
    if (block.type === "text") return { type: "text", text: safeDisplayText(String(block.text)) };
    if (block.type === "thinking") return { type: "thinking", thinking: safeDisplayText(String(block.thinking)) };
    const args = displayValue(block.arguments);
    return { type: "toolCall", id: String(block.id), name: safeDisplayText(String(block.name)), arguments: args !== null && typeof args === "object" && !Array.isArray(args) ? args : {} };
  });
  const reason = message.stopReason;
  // A component-only projection, never appended as model context or used for accounting.
  return {
    role: "assistant", content, api: "openai-completions", provider: "cloud", model: "remote",
    timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: reason === "aborted" || reason === "error" || reason === "length" || reason === "toolUse" ? reason : "stop",
    ...(typeof message.errorMessage === "string" ? { errorMessage: safeDisplayText(message.errorMessage) } : {}),
  };
}

/** Keep the latest structured snapshots, not a copy of every streamed token. */
export function retainTranscriptEvent(history: TaskEvent[], event: TaskEvent): TaskEvent[] {
  history = history.filter(item => item && Number.isSafeInteger(item.cursor) && record(item.payload));
  const rpc = record(event.payload.rpc);
  if (!rpc || history.some(item => item.cursor === event.cursor)) return history;
  const type = rpc.type;
  if (type === "extension_tool_view") {
    try {
      const view = parseToolPresentation(rpc.view);
      const filtered = history.filter(item => {
        const old = record(item.payload.rpc);
        const previous = record(old?.view);
        return old?.type !== type || previous?.toolCallId !== view.toolCallId || previous?.expanded !== view.expanded;
      });
      return [...filtered, { ...event, payload: { rpc: { type, view } } }];
    } catch { return history; }
  }
  const messageType = type === "message_start" || type === "message_update" || type === "message_end";
  const toolType = type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end";
  if (!messageType && !toolType && type !== "extension_error" && !(type === "response" && rpc.success === false)) return history;
  let index = -1;
  if (messageType && type !== "message_start" && record(rpc.message)?.role === "assistant") {
    index = history.findLastIndex(item => {
      const previous = record(item.payload.rpc);
      return (previous?.type === "message_start" || previous?.type === "message_update") && record(previous.message)?.role === "assistant";
    });
  } else if (toolType && typeof rpc.toolCallId === "string") {
    index = history.findIndex(item => record(item.payload.rpc)?.toolCallId === rpc.toolCallId);
  }
  const next = [...history];
  const saved: TaskEvent = { ...event, payload: { rpc: record(displayValue(rpc)) ?? {} } };
  if (index < 0) next.push(saved);
  else next[index] = saved;
  return next;
}

/** Native Pi components; never executes a tool or code received from the Worker. */
export class CloudTranscript extends Container {
  private cursor = 0;
  private currentAssistant: AssistantMessageComponent | undefined;
  private readonly assistants: AssistantMessageComponent[] = [];
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly definitions = new Map<string, ToolRenderer>();
  private expanded = false;
  private hideThinking = false;
  private readonly presentations = new Map<string, ToolPresentation[]>();
  private readonly requested = new Set<string>();

  constructor(private readonly tui: TUI, private readonly cwd: string, private readonly requestView?: (view: ToolViewRequest) => void) {
    super();
    for (const create of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
      createBashToolDefinition, createPowerShellToolDefinition, createGrepToolDefinition,
      createFindToolDefinition, createLsToolDefinition]) {
      const definition = create(cwd);
      this.definitions.set(definition.name, definition);
    }
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const tool of this.tools.values()) tool.setExpanded(expanded);
  }

  setHideThinking(hide: boolean): void {
    if (this.hideThinking === hide) return;
    this.hideThinking = hide;
    for (const component of this.assistants) component.setHideThinkingBlock(hide);
  }

  private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = new ToolExecutionComponent(safeDisplayText(name), id, displayValue(args ?? {}), {}, this.definitions.get(name), this.tui, this.cwd);
      tool.setExpanded(this.expanded);
      this.tools.set(id, tool);
      const nativeTool = tool;
      const nativeRender = nativeTool.render.bind(nativeTool);
      nativeTool.render = width => {
          const views = this.presentations.get(id)?.filter(view => view.expanded === this.expanded);
          if (!views?.length) return nativeRender(width);
          const exact = views.find(view => view.width === width);
          const key = `${id}:${width}:${this.expanded}`;
          if (!exact && !this.requested.has(key) && width >= 10 && width <= 500) {
            this.requested.add(key);
            this.requestView?.({ toolCallId: id, width, expanded: this.expanded });
          }
          return (exact ?? views[views.length - 1])!.lines.map(line => truncateToWidth(line, width));
      };
      this.addChild(nativeTool);
    }
    return tool;
  }

  /** Apply ordered journal events once. The owning task is responsible for durable replay. */
  apply(event: TaskEvent): void {
    if (event.cursor <= this.cursor) return;
    this.cursor = event.cursor;
    const rpc = record(event.payload.rpc);
    if (!rpc) return;
    if (rpc.type === "extension_tool_view") {
      try {
        const view = parseToolPresentation(rpc.view);
        const previous = this.presentations.get(view.toolCallId) ?? [];
        this.presentations.set(view.toolCallId, [...previous.filter(item => item.expanded !== view.expanded), view]);
        this.tui.requestRender();
      } catch { /* Invalid presentation must never replace the native fallback. */ }
      return;
    }
    const message = assistant(rpc.message);
    if (message && ["message_start", "message_update", "message_end"].includes(String(rpc.type))) {
      if (rpc.type === "message_start" || !this.currentAssistant) {
        this.currentAssistant = new AssistantMessageComponent(undefined, this.hideThinking);
        this.assistants.push(this.currentAssistant);
        this.addChild(this.currentAssistant);
      }
      this.currentAssistant.updateContent(message, rpc.type !== "message_end");
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        const tool = this.tool(content.id, content.name, content.arguments);
        tool.updateArgs(content.arguments);
        if (rpc.type === "message_end") tool.setArgsComplete();
      }
      if (rpc.type === "message_end") this.currentAssistant = undefined;
    } else if (rpc.type === "message_end" && record(rpc.message)?.role === "user") {
      const content = record(rpc.message)?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) text = content.map(item => record(item)?.text).filter(item => typeof item === "string").join("\n");
      this.addChild(new UserMessageComponent(safeDisplayText(text)));
    } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(rpc.type)) && typeof rpc.toolCallId === "string" && typeof rpc.toolName === "string") {
      const tool = this.tool(rpc.toolCallId, rpc.toolName, rpc.args);
      if (rpc.type === "tool_execution_start") {
        tool.updateArgs(displayValue(rpc.args ?? {}));
        tool.setArgsComplete();
        tool.markExecutionStarted();
      } else if (rpc.type === "tool_execution_update" || rpc.type === "tool_execution_end") {
        const result = record(displayValue(rpc.result ?? rpc.partialResult));
        if (Array.isArray(result?.content)) {
          tool.updateResult({
            content: result.content.filter(item => typeof record(item)?.type === "string"),
            details: result.details, isError: rpc.isError === true,
          }, rpc.type !== "tool_execution_end");
        }
      }
    } else if (rpc.type === "extension_error" || (rpc.type === "response" && rpc.success === false)) {
      this.addChild(new Text(safeDisplayText(String(rpc.error ?? rpc.message ?? "Remote extension error")), 1, 0));
    }
    this.tui.requestRender();
  }
}
