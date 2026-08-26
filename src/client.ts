import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";

import { buildEnvironmentManifest, sha256 } from "./environment.js";
import { detectLocale, translate } from "./i18n.js";
import {
  createWorkspaceArchive,
  parseGitSnapshot,
  serializeWorkspaceArchive,
} from "./git.js";
import {
  exportSessionBranch,
  mergeSessionTail,
  parseSessionArchive,
  serializeSessionArchive,
  writeMergedSession,
} from "./session.js";
import type { ClientFrame, TaskEvent, TaskSpec } from "./protocol.js";
import { applyGitSnapshot } from "./result.js";
import { CloudConnection, normalizeFingerprint } from "./client-network.js";
import { selectSyncItems, type SyncPreflightItem } from "./client-preflight.js";
import { selectCloudMenu, type CloudMenuItem } from "./client-menu.js";
import {
  loadClientState,
  saveClientState,
  type CloudClientState,
  type CloudConnectionState,
} from "./client-state.js";

interface ActiveTask {
  taskId: string;
  cursor: number;
  accepted: boolean;
  socket: WebSocket;
  connection: CloudConnection;
}

interface LastResult {
  connection: CloudConnection;
  artifactId: string;
  sessionArtifactId?: string;
}

const PI_VERSION = "0.84.2";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function displayEvent(
  ctx: ExtensionContext,
  event: TaskEvent,
  tr: (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => string,
): void {
  const rawStatus = typeof event.payload.status === "string" ? event.payload.status : event.kind;
  const status = rawStatus === "running"
    ? tr("task.running")
    : rawStatus === "completed"
      ? tr("task.completed")
      : rawStatus === "aborted"
        ? tr("task.aborted")
        : rawStatus;
  const message =
    typeof event.payload.message === "string"
      ? event.payload.message
      : `${event.kind} #${event.cursor}`;
  ctx.ui.setStatus("pi-cloud", `${status}: ${message}`);
  ctx.ui.setWidget("pi-cloud", [
    `Pi Cloud`,
    `${event.taskId}  ${status}`,
    message,
  ]);
}

function parsePairArgs(
  args: string,
): { baseUrl: string; fingerprint: string; code: string } | undefined {
  const normalized = args.trim().replace(/^\/cloud-pair\s+/, "");
  const [baseUrl, fingerprint, code] = normalized.split(/\s+/);
  return baseUrl && fingerprint && code
    ? { baseUrl, fingerprint, code }
    : undefined;
}

export default async function piCloudExtension(
  pi: ExtensionAPI,
): Promise<void> {
  let state: CloudClientState = await loadClientState();
  let locale = detectLocale(state.locale);
  const tr = (
    key: Parameters<typeof translate>[1],
    params: Record<string, string | number> = {},
  ) => translate(locale, key, params);
  let active: ActiveTask | undefined;
  let lastResult: LastResult | undefined;

  const connectionFor = (
    workerId?: string,
  ):
    | { record: CloudConnectionState; connection: CloudConnection }
    | undefined => {
    const record = state.connections.find(
      (item) => item.workerId === (workerId ?? state.activeWorkerId),
    );
    return record
      ? {
          record,
          connection: new CloudConnection(
            record.baseUrl,
            record.fingerprint,
            record.token,
          ),
        }
      : undefined;
  };

  const saveConnection = async (
    record: CloudConnectionState,
  ): Promise<void> => {
    state = {
      ...state,
      connections: [
        ...state.connections.filter(
          (item) => item.workerId !== record.workerId,
        ),
        record,
      ],
      activeWorkerId: record.workerId,
    };
    await saveClientState(state);
  };

  pi.registerCommand("cloud-pair", {
    description: tr("cloud.pairDescription"),
    handler: async (args, ctx) => {
      let input = parsePairArgs(args);
      if (!input && ctx.hasUI) {
        const baseUrl = await ctx.ui.input(
          tr("cloud.pairUrlPrompt"),
          "https://127.0.0.1:9443",
        );
        const fingerprint = await ctx.ui.input(
          tr("cloud.pairFingerprintPrompt"),
          "AA:BB:...",
        );
        const code = await ctx.ui.input(tr("cloud.pairCodePrompt"), "");
        if (baseUrl && fingerprint && code)
          input = { baseUrl, fingerprint, code };
      }
      if (!input) {
        ctx.ui.notify(tr("cloud.pairUsage"), "error");
        return;
      }
      const connection = new CloudConnection(
        input.baseUrl.replace(/\/$/, ""),
        input.fingerprint,
      );
      try {
        const paired = await connection.pair(input.code);
        await saveConnection({
          baseUrl: connection.baseUrl,
          workerId: paired.workerId,
          fingerprint: normalizeFingerprint(input.fingerprint),
          token: paired.token,
          pairedAt: new Date().toISOString(),
        });
        ctx.ui.notify(tr("cloud.paired", { workerId: paired.workerId }), "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message === "CERTIFICATE_MISMATCH" ? `${tr("pair.certificateUntrusted")} · ${tr("cloud.pairFingerprintPrompt")}` : message, "error");
      }
    },
  });

  pi.registerCommand("cloud-unpair", {
    description: tr("cloud.unpairDescription"),
    handler: async (_args, ctx) => {
      const selected = connectionFor();
      if (!selected) {
        ctx.ui.notify(tr("cloud.noWorker"), "info");
        return;
      }
      state = {
        ...state,
        connections: state.connections.filter(
          (item) => item.workerId !== selected.record.workerId,
        ),
      };
      await saveClientState(state);
      ctx.ui.notify(tr("cloud.unpaired"), "info");
    },
  });

  pi.registerCommand("cloud-abort", {
    description: tr("cloud.abortDescription"),
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify(tr("cloud.noTask"), "info");
        return;
      }
      active.connection.send(active.socket, {
        type: "task_abort",
        taskId: active.taskId,
      });
      ctx.ui.notify(tr("cloud.abortRequested"), "info");
    },
  });

  pi.registerCommand("cloud-submit", {
    description: tr("cloud.submitDescription"),
    handler: async (args, ctx) => {
      if (active) {
        ctx.ui.notify(
          tr("cloud.taskActive", { taskId: active.taskId }),
          "error",
        );
        return;
      }
      const selected = connectionFor();
      if (!selected) {
        ctx.ui.notify(tr("cloud.noWorker"), "error");
        return;
      }
      const prompt =
        args.trim() ||
        (ctx.hasUI
          ? await ctx.ui.input(
              tr("cloud.remotePrompt"),
              tr("cloud.defaultPrompt"),
            )
          : tr("cloud.defaultPrompt"));
      if (!prompt) return;
      const archive = exportSessionBranch(ctx.sessionManager);
      const workspace = await createWorkspaceArchive(ctx.cwd);
      const manifest = await buildEnvironmentManifest({
        agentDir: agentDir(),
        cwd: ctx.cwd,
        piVersion: PI_VERSION,
        nodeVersion: process.version,
        platform: platform(),
      });
      let authData: Buffer | undefined;
      try {
        authData = await readFile(join(agentDir(), "auth.json"));
      } catch {
        authData = undefined;
      }
      const taskId = randomUUID();
      const environmentData = Buffer.from(`${JSON.stringify(manifest)}\n`);
      const gitData = Buffer.from(serializeWorkspaceArchive(workspace));
      const sessionData = Buffer.from(serializeSessionArchive(archive));
      const preflightItems: SyncPreflightItem[] = [
          {
            id: "environment",
            label: tr("cloud.environmentLabel"),
            description: tr("cloud.environmentDescription", {
              resources: manifest.resources.length,
              providers: manifest.providers.length,
              size: formatBytes(environmentData.byteLength),
            }),
            selected: true,
          },
          {
            id: "git",
            label: tr("cloud.gitLabel"),
            description: tr("cloud.gitDescription", {
              files: workspace.snapshot.files.length,
              size: formatBytes(gitData.byteLength),
            }),
            selected: true,
            required: true,
          },
          {
            id: "session",
            label: tr("cloud.sessionLabel"),
            description: tr("cloud.sessionDescription", {
              entries: archive.entries.length,
              size: formatBytes(sessionData.byteLength),
            }),
            selected: true,
          },
        ];
      if (authData) {
        preflightItems.push({
          id: "credentials",
          label: tr("cloud.credentialsLabel"),
          description: tr("cloud.credentialsDescription"),
          selected: false,
        });
      }
      const chosen = await selectSyncItems(
        ctx,
        preflightItems,
        {
          title: tr("cloud.preflightTitle"),
          required: tr("cloud.required"),
          upload: tr("cloud.upload"),
          cancel: tr("cloud.cancel"),
          help: tr("cloud.preflightHelp"),
          empty: tr("cloud.preflightEmpty"),
        },
      );
      if (!chosen) {
        ctx.ui.notify(tr("cloud.cancelled"), "info");
        return;
      }
      const payloads = [
        { selectionId: "environment", id: `${taskId}-environment`, kind: "environment" as const, data: environmentData, contentType: "application/json" },
        { selectionId: "git", id: `${taskId}-git`, kind: "workspace" as const, data: gitData, contentType: "application/json" },
        { selectionId: "session", id: `${taskId}-session`, kind: "session" as const, data: sessionData, contentType: "application/jsonl" },
      ].filter((payload) => chosen.has(payload.selectionId));
      const emptyEnvironment = {
        piVersion: manifest.piVersion,
        nodeVersion: manifest.nodeVersion,
        platform: manifest.platform,
        packages: [],
        resources: [],
        providers: [],
        secretVersions: [],
        warnings: manifest.warnings,
      };
      const leafId = archive.entries.at(-1)?.id ?? null;
      const task: TaskSpec = {
        taskId,
        projectId: ctx.cwd,
        prompt,
        runner: "docker",
        environment: chosen.has("environment") ? manifest : emptyEnvironment,
        git: workspace.snapshot.baseline,
        session: chosen.has("session")
          ? { sessionId: archive.header.id, baseLeafId: leafId, lastEntryId: leafId, entriesSha256: archive.entriesSha256 }
          : { sessionId: randomUUID(), baseLeafId: null, lastEntryId: null, entriesSha256: sha256("") },
        artifacts: payloads.map((payload) => ({
          id: payload.id,
          kind: payload.kind,
          size: payload.data.byteLength,
          sha256: sha256(payload.data),
          contentType: payload.contentType,
        })),
        secretIds: chosen.has("credentials") ? ["pi-auth"] : [],
      };
      if (chosen.has("credentials") && authData) {
        ctx.ui.setStatus("pi-cloud", tr("cloud.credentialsLabel"));
        await selected.connection.uploadSecret("pi-auth", authData.toString("utf8"));
      }
      for (const payload of payloads) {
        ctx.ui.setStatus("pi-cloud", `${tr("cloud.upload")}: ${payload.selectionId}`);
        await selected.connection.upload(payload.id, payload.data, payload.contentType);
      }
      ctx.ui.setStatus("pi-cloud", undefined);
      const socket = await selected.connection.openEvents((frame) => {
        if (frame.type === "task_accepted" && frame.taskId === taskId) {
          if (active) active.accepted = frame.status === "running";
          return;
        }
        if (frame.type !== "task_event" || frame.event.taskId !== taskId)
          return;
        if (active) {
          active.cursor = frame.event.cursor;
          if (frame.event.payload.status === "running") active.accepted = true;
        }
        displayEvent(ctx, frame.event, tr);
        pi.appendEntry("pi-cloud-live", {
          taskId,
          cursor: frame.event.cursor,
          event: frame.event,
        });
        if (typeof frame.event.payload.resultArtifactId === "string")
          lastResult = {
            connection: selected.connection,
            artifactId: frame.event.payload.resultArtifactId,
            ...(typeof frame.event.payload.sessionArtifactId === "string"
              ? { sessionArtifactId: frame.event.payload.sessionArtifactId }
              : {}),
          };
        if (
          ["completed", "failed", "aborted"].includes(
            String(frame.event.payload.status),
          )
        ) {
          const statusKey =
            frame.event.payload.status === "completed"
              ? "task.completed"
              : frame.event.payload.status === "aborted"
                ? "task.aborted"
                : "result.baseMismatch";
          ctx.ui.notify(
            tr(statusKey),
            frame.event.payload.status === "completed" ? "info" : "error",
          );
          active?.socket.close();
          active = undefined;
          ctx.ui.setWidget("pi-cloud", undefined);
        }
      });
      active = {
        taskId,
        cursor: 0,
        accepted: false,
        socket,
        connection: selected.connection,
      };
      selected.connection.send(socket, {
        type: "hello",
        protocolVersion: 1,
        clientId: archive.header.id,
      });
      selected.connection.send(socket, { type: "task_create", task });
      ctx.ui.notify(tr("cloud.started", { taskId }), "info");
    },
  });

  pi.registerCommand("cloud-reconnect", {
    description: tr("cloud.reconnectDescription"),
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify(tr("cloud.noTask"), "info");
        return;
      }
      active.socket.close();
      const task = active;
      task.socket = await task.connection.openEvents((frame) => {
        if (frame.type !== "task_event" || frame.event.taskId !== task.taskId)
          return;
        task.cursor = frame.event.cursor;
        displayEvent(ctx, frame.event, tr);
      });
      task.connection.send(task.socket, {
        type: "task_resume",
        taskId: task.taskId,
        afterCursor: task.cursor,
      });
      ctx.ui.notify(tr("cloud.reconnected"), "info");
    },
  });

  pi.registerCommand("cloud-apply", {
    description: tr("cloud.applyDescription"),
    handler: async (args, ctx) => {
      const connection = lastResult?.connection ?? connectionFor()?.connection;
      const artifactId = args.trim() || lastResult?.artifactId;
      if (!connection || !artifactId) {
        ctx.ui.notify(tr("result.ready"), "info");
        return;
      }
      const snapshotData = await connection.download(artifactId);
      const snapshot = parseGitSnapshot(snapshotData.toString("utf8"));
      const choice = ctx.hasUI
        ? await ctx.ui.select(tr("result.ready"), [
            ...snapshot.files.map((file) => `${file.status}: ${file.path}`),
            tr("cloud.cancel"),
          ])
        : tr("cloud.cancel");
      if (choice === tr("cloud.cancel") || !choice) return;
      const changed = await applyGitSnapshot(ctx.cwd, snapshot);
      ctx.ui.notify(`${tr("result.ready")}: ${changed.length}`, "info");
    },
  });

  pi.registerCommand("cloud-merge", {
    description: tr("cloud.mergeDescription"),
    handler: async (args, ctx) => {
      const connection = lastResult?.connection ?? connectionFor()?.connection;
      const artifactId = args.trim() || lastResult?.sessionArtifactId;
      if (!connection || !artifactId) {
        ctx.ui.notify(tr("cloud.mergeUsage"), "info");
        return;
      }
      const source = exportSessionBranch(ctx.sessionManager);
      const remoteData = await connection.download(artifactId);
      const remote = parseSessionArchive(remoteData.toString("utf8"));
      const merged = mergeSessionTail(source, remote, {
        sessionId: source.header.id,
        baseLeafId: source.leafId,
        lastEntryId: source.leafId,
        entriesSha256: source.entriesSha256,
      });
      const path = join(
        ctx.cwd,
        ".pi",
        `cloud-merged-${merged.header.id}.jsonl`,
      );
      await writeMergedSession(path, merged);
      const switched = await ctx.switchSession(path);
      if (!switched.cancelled) ctx.ui.notify(tr("result.ready"), "info");
    },
  });

  pi.registerCommand("cloud-status", {
    description: tr("cloud.statusDescription"),
    handler: async (_args, ctx) => {
      const selected = connectionFor();
      const lines = selected
        ? [
            tr("cloud.connected", { address: selected.record.baseUrl, workerId: selected.record.workerId }),
            `TLS SHA-256: ${selected.record.fingerprint}`,
            active ? tr("cloud.activeStatus", { taskId: active.taskId, cursor: active.cursor }) : tr("cloud.idleStatus"),
          ]
        : [tr("cloud.disconnected")];
      ctx.ui.setWidget("pi-cloud", lines);
      ctx.ui.notify(lines[0] ?? tr("cloud.disconnected"), selected ? "info" : "warning");
    },
  });

  pi.registerCommand("cloud-help", {
    description: tr("cloud.helpDescription"),
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("pi-cloud-help", tr("cloud.helpText").split("\n"));
      ctx.ui.notify(tr("cloud.helpChoice"), "info");
    },
  });

  pi.registerCommand("cloud-language", {
    description: tr("cloud.languageDescription"),
    handler: async (_args, ctx) => {
      const selected = ctx.hasUI ? await ctx.ui.select(tr("cloud.languageChoice"), ["简体中文", "English"]) : undefined;
      if (!selected) return;
      locale = selected === "简体中文" ? "zh-CN" : "en";
      state = { ...state, locale };
      await saveClientState(state);
      ctx.ui.notify(tr("language.set", { locale }), "info");
      await ctx.reload();
    },
  });

  pi.registerCommand("cloud-sponsor", {
    description: tr("recommendation.sponsorPlaceholder"),
    handler: async (_args, ctx) =>
      ctx.ui.notify(tr("recommendation.sponsorPlaceholder"), "info"),
  });

  pi.registerCommand("cloud", {
    description: tr("cloud.menu"),
    handler: async (args, ctx) => {
      const command = args.trim();
      const commandMap: Record<string, string> = {
        pair: "/cloud-pair",
        submit: "/cloud-submit",
        abort: "/cloud-abort",
        reconnect: "/cloud-reconnect",
        status: "/cloud-status",
        help: "/cloud-help",
        language: "/cloud-language",
        unpair: "/cloud-unpair",
        apply: "/cloud-apply",
        merge: "/cloud-merge",
      };
      const sendCommand = (value: string) => pi.sendUserMessage(value, { deliverAs: "followUp", expandPromptTemplates: true });
      if (commandMap[command]) {
        sendCommand(commandMap[command]);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(tr("cloud.helpText"), "info");
        return;
      }
      ctx.ui.setWidget("pi-cloud-help", undefined);
      const selected = connectionFor();
      const status = selected
        ? [
            tr("cloud.connected", { address: selected.record.baseUrl, workerId: selected.record.workerId }),
            active ? tr("cloud.activeStatus", { taskId: active.taskId, cursor: active.cursor }) : tr("cloud.idleStatus"),
          ]
        : [tr("cloud.disconnected")];
      const items: CloudMenuItem[] = [];
      if (selected) {
        items.push({ value: "submit", label: tr("cloud.submitChoice"), description: tr("cloud.submitDescription") });
        items.push({ value: "status", label: tr("cloud.statusChoice"), description: tr("cloud.statusDescription") });
        if (active) {
          items.push({ value: "reconnect", label: tr("cloud.reconnectDescription"), description: tr("cloud.activeStatus", { taskId: active.taskId, cursor: active.cursor }) });
          items.push({ value: "abort", label: tr("cloud.abortChoice"), description: tr("cloud.abortDescription") });
        }
        if (lastResult) {
          items.push({ value: "apply", label: tr("result.ready"), description: tr("cloud.applyDescription") });
          if (lastResult.sessionArtifactId) items.push({ value: "merge", label: tr("cloud.mergeDescription"), description: tr("cloud.mergeDescription") });
        }
        items.push({ value: "unpair", label: tr("cloud.unpairChoice"), description: tr("cloud.unpairDescription") });
      } else {
        items.push({ value: "pair", label: tr("cloud.pairChoice"), description: tr("cloud.pairDescription") });
      }
      items.push({ value: "help", label: tr("cloud.helpChoice"), description: tr("cloud.helpDescription") });
      items.push({ value: "language", label: tr("cloud.languageChoice"), description: tr("cloud.languageDescription") });
      const choice = await selectCloudMenu(ctx, tr("cloud.menu"), status, items, tr("cloud.menuHelp"));
      if (choice && commandMap[choice]) sendCommand(commandMap[choice]);
    },
  });

  pi.on("input", (event, ctx) => {
    if (!active || event.source === "extension" || event.text.startsWith("/"))
      return { action: "continue" as const };
    if (!active.accepted) {
      ctx.ui.notify(tr("task.submitted", { address: connectionFor()?.record.baseUrl ?? "Worker" }), "info");
      return { action: "handled" as const };
    }
    active.connection.send(active.socket, {
      type: "task_input",
      input: {
        taskId: active.taskId,
        delivery: event.streamingBehavior ?? "followUp",
        message: event.text,
      },
    } satisfies ClientFrame);
    return { action: "handled" as const };
  });

  pi.on("session_shutdown", () => {
    active?.socket.close();
    active = undefined;
  });
}
