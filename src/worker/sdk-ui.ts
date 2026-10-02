import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ComponentInput } from "../component-protocol.js";
import type { TaskUiResponse } from "../protocol.js";
import { SdkComponentHost } from "./sdk-components.js";
import { SdkDialogs } from "./sdk-dialogs.js";

export interface SdkUiOptions {
  theme: () => Theme;
  keys: KeybindingsManager;
  truncate: (line: string, width: number) => string;
  send: (event: Record<string, unknown>) => void;
  getAllThemes: ExtensionUIContext["getAllThemes"];
  getTheme: ExtensionUIContext["getTheme"];
  setTheme: ExtensionUIContext["setTheme"];
}

/** UI callbacks stay in the task process; unsupported local/global control fails explicitly. */
export class SdkUiHost {
  readonly ui: ExtensionUIContext;
  private readonly dialogs: SdkDialogs;
  private readonly components: SdkComponentHost;

  constructor(options: SdkUiOptions) {
    this.dialogs = new SdkDialogs(options.send);
    this.components = new SdkComponentHost(component => options.send({ type: "extension_component", component }), options.truncate);
    const components = this.components;
    // No terminal renderer is started. A component sees only its scoped viewport.
    const tui = {
      requestRender: () => components.requestRender(),
      terminal: { get columns() { return components.columns; }, get rows() { return components.rows; } },
    } as TUI;
    const denied = (): never => { throw new Error("CLOUD_UI_CAPABILITY_UNAVAILABLE"); };
    const emit = (method: string, fields: Record<string, unknown>) => options.send({ type: "extension_ui_request", method, ...fields });
    this.ui = {
      get theme() { return options.theme(); },
      select: async (title, values, opts) => {
        const result = await this.dialogs.ask({ method: "select", title, options: values }, opts);
        return typeof result === "string" ? result : undefined;
      },
      confirm: async (title, message, opts) => (await this.dialogs.ask({ method: "confirm", title, message }, opts)) === true,
      input: async (title, placeholder, opts) => {
        const result = await this.dialogs.ask({ method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}) }, opts);
        return typeof result === "string" ? result : undefined;
      },
      editor: async (title, prefill) => {
        const result = await this.dialogs.ask({ method: "editor", title, ...(prefill !== undefined ? { prefill } : {}) });
        return typeof result === "string" ? result : undefined;
      },
      custom: (factory, settings) => {
        if (settings?.onHandle || settings?.overlayOptions) return Promise.reject(new Error("CLOUD_UI_OVERLAY_CONTROL_UNAVAILABLE"));
        return components.custom(done => factory(tui, options.theme(), options.keys, done));
      },
      notify: (message, type) => emit("notify", { message, notificationType: type ?? "info" }),
      setStatus: (key, text) => emit("setStatus", { statusKey: key, statusText: text }),
      setWorkingMessage: message => emit("setStatus", { statusKey: "working", statusText: message }),
      // These APIs can seize a user's local session/editor or require persistent surfaces.
      // They must gain a scoped implementation before being advertised as compatible.
      onTerminalInput: denied, setWorkingVisible: denied, setWorkingIndicator: denied, setHiddenThinkingLabel: denied,
      setWidget: denied, setFooter: denied, setHeader: denied, setTitle: denied,
      pasteToEditor: denied, setEditorText: denied, getEditorText: denied,
      addAutocompleteProvider: denied, setEditorComponent: denied, getEditorComponent: denied,
      getAllThemes: options.getAllThemes, getTheme: options.getTheme, setTheme: options.setTheme,
      getToolsExpanded: () => false, setToolsExpanded: denied,
    };
  }

  receive(input: ComponentInput): void { this.components.receive(input); }
  answer(response: Omit<TaskUiResponse, "taskId">): void { this.dialogs.answer(response); }
  close(): void { this.dialogs.close(); this.components.close(); }
}
