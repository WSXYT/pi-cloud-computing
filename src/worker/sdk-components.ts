import { randomUUID } from "node:crypto";
import type { Component } from "@earendil-works/pi-tui";
import { safeComponentLine, type ComponentFrame, type ComponentInput } from "../component-protocol.js";
export { safeComponentLine, type ComponentFrame } from "../component-protocol.js";

type HostedComponent = Component & { dispose?(): void };

interface ActiveComponent {
  id: string;
  component?: HostedComponent;
  revision: number;
  settled: boolean;
  fail(error: Error): void;
}

/**
 * Hosts one plugin component at a time, not a remote terminal or full Pi screen.
 * Results and callbacks stay in this process. Only bounded component lines and
 * scoped input IDs cross the transport. The client owns actual TUI focus/layout.
 */
export class SdkComponentHost {
  private active: ActiveComponent | undefined;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private width = 80;
  private height = 24;
  get columns(): number { return this.width; }
  get rows(): number { return this.height; }

  receive(input: ComponentInput): void {
    if (this.active?.id !== input.id) return;
    if (input.type === "cancel") this.cancel(input.id);
    else if (input.type === "input") this.input(input.id, input.data);
    else if (input.type === "resize") this.resize(input.id, input.width, input.height);
    else {
      try { this.active.component?.handleMouse?.(input.event); this.requestRender(); }
      catch { this.active?.fail(new Error("CLOUD_UI_INPUT_FAILED")); }
    }
  }

  constructor(
    private readonly send: (frame: ComponentFrame) => void,
    private readonly truncate: (line: string, width: number) => string,
  ) {}

  custom<T>(factory: (done: (result: T) => void) => HostedComponent | Promise<HostedComponent>): Promise<T> {
    const result = this.queue.then(() => this.show(factory));
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private show<T>(factory: (done: (result: T) => void) => HostedComponent | Promise<HostedComponent>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CLOUD_UI_CLOSED"));
    return new Promise<T>((resolve, reject) => {
      const finish = (value: T | undefined, error?: Error): void => {
        if (active.settled) return;
        active.settled = true;
        clearTimeout(this.timer); this.timer = undefined;
        this.active = undefined;
        try { active.component?.dispose?.(); }
        catch { error ??= new Error("CLOUD_UI_DISPOSAL_FAILED"); }
        try { this.send({ type: "close", id: active.id }); }
        catch { error ??= new Error("CLOUD_UI_TRANSPORT_CLOSED"); }
        if (error) reject(error);
        else resolve(value as T); // Value originates exclusively in the plugin's typed done callback.
      };
      const active: ActiveComponent = { id: randomUUID(), revision: 0, settled: false, fail: error => finish(undefined, error) };
      this.active = active;
      try {
        this.send({ type: "open", id: active.id });
        void Promise.resolve(factory(value => finish(value))).then(component => {
          if (active.settled) { component.dispose?.(); return; }
          active.component = component;
          const focusable = component as HostedComponent & { focused?: boolean };
          if (typeof focusable.focused === "boolean") focusable.focused = true;
          this.render();
        }).catch(() => active.fail(new Error("CLOUD_UI_COMPONENT_FAILED")));
      } catch { active.fail(new Error("CLOUD_UI_COMPONENT_FAILED")); }
    });
  }

  requestRender(): void {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 50);
    this.timer.unref();
  }

  resize(id: string, width: number, height = this.height): void {
    if (this.active?.id !== id || !Number.isSafeInteger(width) || width < 10 || width > 500 || !Number.isSafeInteger(height) || height < 1 || height > 500) return;
    this.width = width;
    this.height = height;
    try { this.active.component?.invalidate(); this.requestRender(); }
    catch { this.active.fail(new Error("CLOUD_UI_RENDER_FAILED")); }
  }

  input(id: string, data: string): void {
    if (this.active?.id !== id || Buffer.byteLength(data) > 64 * 1024) return;
    try { this.active.component?.handleInput?.(data); this.requestRender(); }
    catch { this.active?.fail(new Error("CLOUD_UI_INPUT_FAILED")); }
  }

  cancel(id: string): void {
    if (this.active?.id === id) this.active.fail(new Error("CLOUD_UI_CANCELLED"));
  }

  private render(): void {
    const active = this.active;
    if (!active?.component || active.settled) return;
    try {
      const source = active.component.render(this.width);
      if (source.length > 500) throw new Error("CLOUD_UI_FRAME_TOO_LARGE");
      const lines = source.map(line => this.truncate(safeComponentLine(line), this.width));
      if (Buffer.byteLength(JSON.stringify(lines)) > 128 * 1024) throw new Error("CLOUD_UI_FRAME_TOO_LARGE");
      this.send({ type: "frame", id: active.id, revision: ++active.revision, width: this.width, lines });
    } catch { active.fail(new Error("CLOUD_UI_RENDER_FAILED")); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.active?.fail(new Error("CLOUD_UI_CLOSED"));
  }
}
