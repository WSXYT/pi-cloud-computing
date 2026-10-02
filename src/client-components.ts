import { ExtensionEditorComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ComponentFrame, ComponentInput } from "./component-protocol.js";

/** Pi's stock multiline editor with an externally cancellable dialog lifetime. */
export async function cancellableRemoteEditor(ui: ExtensionUIContext, title: string, prefill: string, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  let abort: (() => void) | undefined;
  try {
    return await ui.custom<string | undefined>((tui, _theme, keys, done) => {
      abort = () => done(undefined);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) queueMicrotask(abort);
      return new ExtensionEditorComponent(tui, keys, title, prefill, done, () => done(undefined));
    });
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

interface Surface {
  id: string;
  revision: number;
  lines: string[];
  closed: boolean;
  done?: () => void;
  redraw?: () => void;
}

/** A scoped native Pi custom-component slot. It never evaluates Worker code. */
export class CloudComponentClient {
  private surface: Surface | undefined;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly dismissed = new Set<string>();

  constructor(
    private readonly ui: ExtensionUIContext,
    private readonly send: (input: ComponentInput) => void,
    private readonly stop: () => void,
    private readonly label: string,
    private readonly waiting: string,
  ) {}

  receive(frame: ComponentFrame): void {
    if (this.closed || this.dismissed.has(frame.id)) return;
    if (frame.type === "close") {
      this.rememberDismissed(frame.id);
      if (this.surface?.id === frame.id) this.dismiss(this.surface);
      return;
    }
    let surface = this.surface;
    if (!surface || surface.closed || surface.id !== frame.id) {
      if (surface) this.dismiss(surface);
      surface = { id: frame.id, revision: 0, lines: [], closed: false };
      this.surface = surface;
      const next = surface;
      this.chain = this.chain.then(() => this.show(next)).catch(() => {
        this.dismiss(next);
        if (!this.closed) this.send({ type: "cancel", id: next.id });
      });
    }
    if (frame.type === "frame" && frame.revision > surface.revision) {
      surface.revision = frame.revision;
      surface.lines = frame.lines;
      surface.redraw?.();
    }
  }

  private rememberDismissed(id: string): void {
    this.dismissed.add(id);
    if (this.dismissed.size > 512) this.dismissed.delete(this.dismissed.values().next().value!);
  }

  private dismiss(surface: Surface): void {
    if (surface.closed) return;
    surface.closed = true;
    this.rememberDismissed(surface.id);
    surface.done?.();
  }

  private async show(surface: Surface): Promise<void> {
    if (this.closed || surface.closed) return;
    await this.ui.custom<void>((tui, theme, _keys, done) => {
      surface.done = () => done();
      surface.redraw = () => tui.requestRender();
      if (this.closed || surface.closed) queueMicrotask(() => done());
      let dimensions = "";
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", this.label), 0, 1));
      container.addChild({
        render: width => {
          const columns = Math.max(10, Math.min(500, width));
          const height = Math.max(1, Math.min(500, tui.terminal.rows - 4));
          const next = `${columns}:${height}`;
          if (!surface.closed && next !== dimensions) {
            dimensions = next;
            this.send({ type: "resize", id: surface.id, width: columns, height });
          }
          return (surface.lines.length ? surface.lines : [this.waiting]).map(line => truncateToWidth(line, width));
        },
        invalidate: () => { dimensions = ""; },
        handleInput: data => {
          if (surface.closed) return;
          if (matchesKey(data, Key.ctrl("c"))) {
            this.dismiss(surface);
            this.stop();
          } else this.send({ type: "input", id: surface.id, data });
        },
        handleMouse: event => {
          if (!surface.closed) this.send({ type: "mouse", id: surface.id, event });
          return { handled: true, capture: event.type === "press" };
        },
      });
      // Containers delegate mouse layout, but keyboard ownership is explicit.
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => container.children[1]?.handleInput?.(data),
        handleMouse: (event: Parameters<Container["handleMouse"]>[0]) => container.handleMouse(event),
      };
    });
    if (!surface.closed) {
      surface.closed = true;
      this.rememberDismissed(surface.id);
      if (!this.closed) this.send({ type: "cancel", id: surface.id });
    }
  }

  close(): void {
    this.closed = true;
    if (this.surface) this.dismiss(this.surface);
  }
}
