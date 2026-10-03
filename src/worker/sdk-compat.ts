// Structural checks complement the minimum version; newer Pi releases are not rejected by name.
function functions(value: unknown, names: string[], code: string): void {
  if (!value || !["object", "function"].includes(typeof value) ||
    names.some(name => typeof (value as Record<string, unknown>)[name] !== "function")) throw new Error(code);
}

export function assertSdkCapabilities(sdk: unknown): void {
  const code = "CLOUD_SDK_CAPABILITY_UNAVAILABLE";
  functions(sdk, ["createAgentSessionServices", "createAgentSessionFromServices", "ToolExecutionComponent"], code);
  const api = sdk as Record<string, unknown>;
  const prototype = (value: unknown): Record<string, unknown> | undefined => typeof value === "function" ? value.prototype : undefined;
  functions(api.SettingsManager, ["create"], code);
  functions(api.SessionManager, ["open"], code);
  functions(prototype(api.AgentSession), ["prompt", "steer", "followUp", "abort", "clearQueue", "subscribe", "bindExtensions", "dispose", "waitForIdle", "getAllTools", "getToolDefinition"], code);
  functions(prototype(api.ToolExecutionComponent), ["updateArgs", "setArgsComplete", "markExecutionStarted", "updateResult", "render"], code);
}

export function assertUiAdapterCapabilities(themes: unknown, bindings: unknown, toolkit: unknown): void {
  const code = "CLOUD_SDK_UI_ADAPTER_UNAVAILABLE";
  functions(themes, ["initTheme", "getAvailableThemesWithPaths", "getThemeByName", "setTheme", "setThemeInstance"], code);
  functions((bindings as { KeybindingsManager?: unknown } | undefined)?.KeybindingsManager, ["create"], code);
  functions(toolkit, ["truncateToWidth"], code);
}
