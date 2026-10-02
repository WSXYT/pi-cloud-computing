import { randomUUID } from "node:crypto";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { TaskUiRequest, TaskUiResponse } from "../protocol.js";

type DialogValue = string | boolean | undefined;
interface PendingDialog {
  request: TaskUiRequest;
  finish(value: DialogValue): void;
}

/** Standard Pi dialogs: no default approvals, with cloud-owned cancellation/deadlines. */
export class SdkDialogs {
  private readonly pending = new Map<string, PendingDialog>();
  private closed = false;
  constructor(private readonly send: (event: Record<string, unknown>) => void) {}

  ask(request: Omit<TaskUiRequest, "id">, options?: ExtensionUIDialogOptions): Promise<DialogValue> {
    const denied = request.method === "confirm" ? false : undefined;
    if (this.closed || options?.signal?.aborted) return Promise.resolve(denied);
    if (this.pending.size >= 100) return Promise.reject(new Error("CLOUD_UI_DIALOG_LIMIT"));
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) return Promise.reject(new Error("CLOUD_UI_TIMEOUT_INVALID"));
    const id = randomUUID();
    return new Promise<DialogValue>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => finish(denied);
      const finish = (value: DialogValue): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        try { this.send({ type: "extension_ui_closed", id }); }
        catch { reject(new Error("CLOUD_UI_TRANSPORT_CLOSED")); return; }
        resolve(value);
      };
      const full: TaskUiRequest = { ...request, id };
      this.pending.set(id, { request: full, finish });
      options?.signal?.addEventListener("abort", cancel, { once: true });
      if (options?.timeout !== undefined) {
        timer = setTimeout(cancel, Math.min(options.timeout, 2_147_483_647));
        timer.unref();
      }
      try { this.send({ type: "extension_ui_request", ...full }); }
      catch {
        this.pending.delete(id); clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        reject(new Error("CLOUD_UI_TRANSPORT_CLOSED"));
      }
    });
  }

  answer(response: Omit<TaskUiResponse, "taskId">): void {
    const pending = this.pending.get(response.id);
    if (!pending) return; // Late replies cannot resolve a later dialog or revive an expired one.
    const { request, finish } = pending;
    if (response.cancelled) { finish(request.method === "confirm" ? false : undefined); return; }
    if (request.method === "confirm") {
      if (typeof response.confirmed === "boolean") finish(response.confirmed);
    } else if (typeof response.value === "string" && (request.method !== "select" || request.options?.includes(response.value))) {
      finish(response.value);
    }
  }

  close(): void {
    this.closed = true;
    for (const dialog of [...this.pending.values()]) dialog.finish(dialog.request.method === "confirm" ? false : undefined);
  }
}
