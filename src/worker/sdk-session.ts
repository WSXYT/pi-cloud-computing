import type {
  AgentSession, AgentSessionEventListener, ExtensionUIContext, InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { TaskSpec } from "../protocol.js";

// Runtime imports are supplied by the task entry point from its installed Pi package.
// This module is copied into the isolated runtime, not loaded with Worker credentials.
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type ThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

export interface SdkTaskSessionOptions {
  cwd: string;
  agentDir: string;
  sessionPath: string;
  projectTrusted: boolean;
  model?: TaskSpec["model"];
  ui: ExtensionUIContext;
  onEvent: AgentSessionEventListener;
  onError: NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["onError"]>;
  extensionFactories?: InlineExtension[];
}

function thinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  switch (value) {
    case undefined: case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": return value;
    default: throw new Error("CLOUD_THINKING_LEVEL_UNSUPPORTED");
  }
}

/** Create the real Pi session; rendering and input delivery belong to the UI host. */
export async function createSdkTaskSession(pi: PiSdk, options: SdkTaskSessionOptions): Promise<AgentSession> {
  const settingsManager = pi.SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: options.projectTrusted });
  const services = await pi.createAgentSessionServices({
    cwd: options.cwd, agentDir: options.agentDir, settingsManager,
    modelRuntimeSignal: AbortSignal.timeout(15_000),
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => options.projectTrusted },
    resourceLoaderOptions: { ...(options.extensionFactories ? { extensionFactories: options.extensionFactories } : {}) },
  });
  if (services.resourceLoader.getExtensions().errors.length || services.diagnostics.some(item => item.type === "error")) {
    throw new Error("CLOUD_RUNTIME_RESOURCE_FAILED");
  }
  const selected = options.model ? services.modelRuntime.getModel(options.model.provider, options.model.id) : undefined;
  if (options.model && !selected) throw new Error("CLOUD_SELECTED_MODEL_UNAVAILABLE");
  const thinking = thinkingLevel(options.model?.thinkingLevel);
  const { session } = await pi.createAgentSessionFromServices({
    services, sessionManager: pi.SessionManager.open(options.sessionPath),
    ...(selected ? { model: selected } : {}),
    ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
  });
  const unsubscribe = session.subscribe(options.onEvent);
  // A fixed task cannot silently switch sessions and evade its result/cleanup ownership.
  const denyReplacement = async (): Promise<never> => { throw new Error("CLOUD_TASK_SESSION_REPLACEMENT_UNSUPPORTED"); };
  try {
    await session.bindExtensions({
      mode: "tui", uiContext: options.ui,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: denyReplacement, fork: denyReplacement, navigateTree: denyReplacement,
        switchSession: denyReplacement, reload: denyReplacement,
      },
      onError: options.onError,
    });
    return session;
  } catch (error) {
    unsubscribe();
    session.dispose();
    throw error;
  }
}
