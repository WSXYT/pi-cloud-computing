import type { AgentSession, AgentSessionEventListener, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { safeComponentLine, type ToolPresentation } from "../component-protocol.js";
export type { ToolPresentation } from "../component-protocol.js";

type ToolComponent = ToolExecutionComponent;
type PiSdk = typeof import("@earendil-works/pi-coding-agent");

/** Render extension tools inside their task using Pi's own component/state contract. */
export class SdkToolPresentations {
  private readonly tools = new Map<string, ToolComponent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly dirty = new Set<string>();
  private closed = false;
  private readonly lastFrames = new Map<string, string>();

  constructor(
    private readonly sdk: PiSdk,
    private readonly session: AgentSession,
    private readonly cwd: string,
    private readonly send: (view: ToolPresentation) => void,
    private readonly truncate: (line: string, width: number) => string,
    private readonly onError: (code: string) => void,
  ) {}

  apply(event: Parameters<AgentSessionEventListener>[0]): void {
    if (this.closed) return;
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
    let component = this.tools.get(event.toolCallId);
    if (!component) {
      const definition = this.session.getToolDefinition(event.toolName);
      if (!definition?.renderCall && !definition?.renderResult) return;
      // Built-in renderers already run natively on the client; only plugin-owned rows need the bridge.
      if (this.session.getAllTools().find(tool => tool.name === event.toolName)?.sourceInfo.source === "builtin") return;
      if (this.tools.size >= 500) throw new Error("CLOUD_TOOL_PRESENTATION_LIMIT");
      const tui = { requestRender: () => this.invalidate(event.toolCallId) } as TUI;
      component = new this.sdk.ToolExecutionComponent(event.toolName, event.toolCallId, event.type === "tool_execution_end" ? {} : event.args, {}, definition, tui, this.cwd);
      this.tools.set(event.toolCallId, component);
    }
    if (event.type !== "tool_execution_end") component.updateArgs(event.args);
    component.setArgsComplete();
    component.markExecutionStarted();
    if (event.type === "tool_execution_update") component.updateResult(event.partialResult, true);
    if (event.type === "tool_execution_end") component.updateResult({ ...event.result, isError: event.isError }, false);
    this.invalidate(event.toolCallId);
    if (event.type === "tool_execution_end") this.flush();
  }

  private invalidate(id: string): void {
    if (this.closed) return;
    this.dirty.add(id);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 50);
    this.timer.unref();
  }

  flush(): void {
    const ids = [...this.dirty]; this.dirty.clear();
    for (const key of ids) {
      try { this.render(key, 80, false); this.render(key, 80, true); }
      catch { this.onError("CLOUD_TOOL_PRESENTATION_FAILED"); }
    }
  }

  render(id: string, width: number, expanded: boolean): void {
    if (this.closed || !Number.isSafeInteger(width) || width < 10 || width > 500) return;
    const component = this.tools.get(id);
    if (!component) return;
    component.setExpanded(expanded);
    const source = component.render(width);
    if (source.length > 500) throw new Error("CLOUD_TOOL_PRESENTATION_TOO_LARGE");
    const lines = source.map(line => this.truncate(safeComponentLine(line), width));
    const serialized = JSON.stringify(lines);
    if (Buffer.byteLength(serialized) > 128 * 1024) throw new Error("CLOUD_TOOL_PRESENTATION_TOO_LARGE");
    const key = `${id}:${expanded}`;
    const fingerprint = `${width}:${serialized}`;
    if (this.lastFrames.get(key) === fingerprint) return;
    this.lastFrames.set(key, fingerprint);
    this.send({ toolCallId: id, width, expanded, lines });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.tools.clear(); this.dirty.clear(); this.lastFrames.clear();
  }
}
