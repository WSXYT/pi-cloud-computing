// Executed only inside the isolated task runtime, after dependency preparation.
import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { KeybindingsManager, Theme, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseComponentInput, parseToolViewRequest } from "../component-protocol.js";
import { validateIdentifier } from "../paths.js";
import { parseTaskInput, parseTaskUiResponse } from "../protocol.js";
import { createSdkTaskSession } from "./sdk-session.js";
import { SdkUiHost } from "./sdk-ui.js";
import { SdkToolPresentations } from "./sdk-tool-presentations.js";

type RuntimeEvent = Parameters<import("@earendil-works/pi-coding-agent").AgentSessionEventListener>[0] | Record<string, unknown>;
const emit = (event: RuntimeEvent): void => { process.stdout.write(JSON.stringify(event) + "\n"); };
async function piEntry(): Promise<string> {
  if (process.env.PI_CLOUD_PI_ENTRY) return process.env.PI_CLOUD_PI_ENTRY;
  // The pinned Docker image supplies a normal npm symlink; never invoke a shell.
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try { return await realpath(join(directory, "pi")); } catch { /* next PATH entry */ }
  }
  throw new Error("CLOUD_PI_ENTRY_UNAVAILABLE");
}

let startupPhase = "resolve_sdk";
async function main(): Promise<void> {
  const started = performance.now();
  const stage = (name: string): void => emit({ type: "cloud_runtime_stage", stage: name, elapsedMs: Math.round(performance.now() - started) });
  stage("resolve_sdk");
  const entry = pathToFileURL(await piEntry());
  // The pinned npm CLI lives in dist/bundle; its ESM-only exports cannot use require.resolve.
  const packageUrl = new URL("../../package.json", entry);
  const metadata = JSON.parse(await readFile(packageUrl, "utf8")) as { name?: string; version?: string };
  if (metadata.name !== "@earendil-works/pi-coding-agent" || metadata.version !== "0.85.1") throw new Error("CLOUD_SDK_VERSION_UNSUPPORTED");
  const require = createRequire(entry);
  const sdkUrl = new URL("../index.js", entry);
  const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(sdkUrl.href);
  const toolkit: typeof import("@earendil-works/pi-tui") = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
  // Pi 0.85.1 does not re-export its active Theme or constructible app keybindings.
  // Keep these two narrow adapters version-pinned; no renderer or Pi internals are patched.
  if (sdk.VERSION !== "0.85.1") throw new Error("CLOUD_SDK_VERSION_UNSUPPORTED");
  startupPhase = "load_ui_adapter";
  stage(startupPhase);
  const themes = await import(new URL("./modes/interactive/theme/theme.js", sdkUrl).href) as {
    theme: Theme; initTheme(name?: string, watch?: boolean): void;
    getAvailableThemesWithPaths: ExtensionUIContext["getAllThemes"];
    getThemeByName: ExtensionUIContext["getTheme"];
    setTheme(name: string, watch?: boolean): { success: boolean; error?: string };
    setThemeInstance(theme: Theme): void;
  };
  const bindings = await import(new URL("./core/keybindings.js", sdkUrl).href) as { KeybindingsManager: { create(agentDir: string): KeybindingsManager } };
  const args = process.argv.slice(2);
  const option = (key: string): string | undefined => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const agentDir = process.env.PI_CODING_AGENT_DIR, sessionPath = option("--session");
  if (!agentDir || !sessionPath) throw new Error("CLOUD_TASK_PROFILE_REQUIRED");
  const settings = sdk.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: args.includes("--approve") });
  themes.initTheme(settings.getTheme(), false);
  startupPhase = "create_ui";
  stage(startupPhase);
  const ui = new SdkUiHost({
    theme: () => themes.theme, keys: bindings.KeybindingsManager.create(agentDir), truncate: toolkit.truncateToWidth, send: emit,
    getAllThemes: themes.getAvailableThemesWithPaths, getTheme: themes.getThemeByName,
    setTheme: value => { if (typeof value === "string") return themes.setTheme(value, false); themes.setThemeInstance(value); return { success: true }; },
  });
  let agentStarts = 0;
  let presentations: SdkToolPresentations | undefined;
  const provider = option("--provider"), model = option("--model"), thinking = option("--thinking");
  startupPhase = "create_session";
  const ready = createSdkTaskSession(sdk, {
    cwd: process.cwd(), agentDir, sessionPath, projectTrusted: args.includes("--approve"), ui: ui.ui,
    ...(provider && model ? { model: { provider, id: model, ...(thinking ? { thinkingLevel: thinking } : {}) } } : {}),
    onEvent: event => {
      if (event.type === "agent_start") agentStarts++;
      emit(event);
      try { presentations?.apply(event); }
      catch { emit({ type: "extension_error", error: "CLOUD_TOOL_PRESENTATION_FAILED" }); }
    },
    onError: error => emit({ type: "extension_error", extensionPath: error.extensionPath, event: error.event, error: error.error }),
    onStage: stage,
  });
  const dequeued = new Map<string, ReturnType<import("@earendil-works/pi-coding-agent").AgentSession["clearQueue"]>>();
  let promptPending = false, closing = false;
  let queueOperations: Promise<unknown> = Promise.resolve();
  const queueOperation = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = queueOperations.then(operation);
    queueOperations = result.catch(() => {});
    return result;
  };
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true; ui.close(); presentations?.close();
    const session = await ready;
    await session.abort();
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  };
  const fail = (id: unknown, code: string): void => emit({ type: "response", id: typeof id === "string" ? id : "pi-cloud-initial", command: "prompt", success: false, error: code });
  const handle = async (raw: unknown): Promise<void> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CLOUD_COMMAND_INVALID");
    const command = raw as Record<string, unknown>;
    if (command.type === "extension_tool_view_request") {
      const view = parseToolViewRequest(command.view);
      presentations?.render(view.toolCallId, view.width, view.expanded); return;
    }
    if (command.type === "extension_component_input") { ui.receive(parseComponentInput(command.input)); return; }
    if (command.type === "extension_ui_response") { ui.answer(parseTaskUiResponse({ ...command, taskId: "sdk" })); return; }
    if (command.type === "abort") ui.close();
    const session = await ready;
    if (command.type === "cloud_dequeue") {
      validateIdentifier(command.requestId);
      const requestId = command.requestId as string;
      if (!dequeued.has(requestId)) {
        if (dequeued.size >= 100) throw new Error("CLOUD_QUEUE_EDIT_LIMIT");
        await queueOperation(() => { if (!dequeued.has(requestId)) dequeued.set(requestId, session.clearQueue()); });
      }
      emit({ type: "cloud_queue_restored", requestId, ...dequeued.get(requestId) });
      return;
    }
    if (command.type === "clear_queue") { await queueOperation(() => session.clearQueue()); return; }
    if (command.type === "abort") { await session.abort(); return; }
    if (command.type !== "prompt" || closing) throw new Error("CLOUD_COMMAND_INVALID");
    const input = parseTaskInput({ taskId: "sdk", message: command.message, delivery: command.streamingBehavior ?? "prompt", ...(command.images ? { images: command.images } : {}) });
    const imageOptions = input.images ? { images: input.images } : undefined;
    if (promptPending || session.isStreaming) {
      await queueOperation(async () => {
        if (closing) throw new Error("CLOUD_TASK_CLOSED");
        if (input.delivery === "steer") await session.steer(input.message, input.images);
        else await session.followUp(input.message, input.images);
      });
      emit({ type: "response", id: command.id, command: "prompt", success: true });
      return;
    }
    promptPending = true;
    const starts = agentStarts;
    try {
      const running = session.prompt(input.message, { ...imageOptions, expandPromptTemplates: true });
      emit({ type: "response", id: command.id, command: "prompt", success: true });
      await running;
      if (starts === agentStarts) {
        if (session.pendingMessageCount) fail(command.id, "CLOUD_COMMAND_PENDING_INPUT_UNSUPPORTED");
        else emit({ type: "agent_settled" });
      }
    } catch { fail(command.id, "CLOUD_PROMPT_FAILED"); }
    finally { promptPending = false; }
  };
  const decoder = new StringDecoder("utf8"); let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    if (Buffer.byteLength(pending) > 50 * 1024 * 1024) { pending = ""; fail(undefined, "CLOUD_COMMAND_TOO_LARGE"); return; }
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line) continue;
      try { void handle(JSON.parse(line)).catch(() => fail(undefined, "CLOUD_COMMAND_INVALID")); }
      catch { fail(undefined, "CLOUD_COMMAND_INVALID"); }
    }
  });
  process.stdin.once("end", () => { void close().catch(() => { process.exitCode = 1; }); });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  const session = await ready;
  presentations = new SdkToolPresentations(sdk, session, process.cwd(), view => emit({ type: "extension_tool_view", view }), toolkit.truncateToWidth, error => emit({ type: "extension_error", error }));
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const diagnosis = /^CLOUD_[A-Z_]+$/.test(message) ? message : /^[A-Z_]{1,64}$/.test(code) ? code : "STARTUP_FAILED";
  emit({ type: "response", id: "pi-cloud-initial", command: "prompt", success: false, error: `CLOUD_SDK_STARTUP_FAILED (${startupPhase}: ${diagnosis})` });
  process.exitCode = 1;
});
