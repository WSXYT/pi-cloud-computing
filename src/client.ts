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
import type {
  ClientFrame,
  TaskEvent,
  TaskResult,
  TaskSnapshot,
  TaskSpec,
  TaskStatus,
} from "./protocol.js";
import { applyGitSnapshot } from "./result.js";
import { CloudConnection, normalizeFingerprint } from "./client-network.js";
import { selectSyncItems, type SyncPreflightItem } from "./client-preflight.js";
import { selectCloudMenu, type CloudMenuItem } from "./client-menu.js";
import {
  loadClientState,
  saveClientState,
  type CloudClientState,
  type CloudConnectionState,
  type CloudTaskState,
} from "./client-state.js";

interface ActiveTask {
  state: CloudTaskState;
  accepted: boolean;
  socket: WebSocket | undefined;
  connection: CloudConnection;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
}

const TERMINAL = new Set<TaskStatus>(["completed", "failed", "aborted"]);
const PI_VERSION = "0.84.2";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function formatNetworkError(
  error: unknown,
  address: string,
  tr: (
    key: Parameters<typeof translate>[1],
    params?: Record<string, string | number>,
  ) => string,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${tr("cloud.networkError", { address })}: ${detail}`;
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

function displayEvent(
  ctx: ExtensionContext,
  event: TaskEvent,
  tr: (
    key: Parameters<typeof translate>[1],
    params?: Record<string, string | number>,
  ) => string,
): void {
  const rawStatus =
    typeof event.payload.status === "string"
      ? event.payload.status
      : event.kind;
  const status =
    rawStatus === "running"
      ? tr("task.running")
      : rawStatus === "completed"
        ? tr("task.completed")
        : rawStatus === "failed"
          ? tr("task.failed")
          : rawStatus === "aborted"
            ? tr("task.aborted")
            : rawStatus;
  const detail =
    typeof event.payload.message === "string"
      ? event.payload.message
      : typeof event.payload.text === "string"
        ? event.payload.text
        : event.kind;
  ctx.ui.setStatus("pi-cloud", `${status} · #${event.cursor}`);
  ctx.ui.setWidget("pi-cloud", [
    "Pi Cloud",
    `${event.taskId} · ${status}`,
    detail,
    tr("cloud.liveHelp"),
  ]);
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
  let lastResult: CloudTaskState | undefined;
  let shuttingDown = false;
  let persistence = Promise.resolve();

  const persistState = (): Promise<void> => {
    persistence = persistence
      .catch(() => undefined)
      .then(() => saveClientState(state));
    return persistence;
  };

  const persistTask = async (task: CloudTaskState): Promise<void> => {
    const tasks = [
      ...(state.tasks ?? []).filter((item) => item.taskId !== task.taskId),
      task,
    ].slice(-50);
    state = { ...state, tasks };
    await persistState();
  };

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
    await persistState();
  };

  const completeFromResult = (task: ActiveTask, result: TaskResult): void => {
    task.state.status = result.status;
    if (result.resultArtifactId)
      task.state.artifactId = result.resultArtifactId;
    if (result.sessionArtifactId)
      task.state.sessionArtifactId = result.sessionArtifactId;
    lastResult = task.state;
  };

  const finishTask = (
    task: ActiveTask,
    snapshot: TaskSnapshot,
    ctx: ExtensionContext,
  ): void => {
    if (TERMINAL.has(task.state.status) && active?.state.taskId !== task.state.taskId)
      return;
    task.state.status = snapshot.status;
    task.state.cursor = Math.max(task.state.cursor, snapshot.cursor);
    if (snapshot.result) completeFromResult(task, snapshot.result);
    lastResult = task.state;
    if (task.reconnectTimer) clearTimeout(task.reconnectTimer);
    task.socket?.close();
    task.socket = undefined;
    if (active?.state.taskId === task.state.taskId) active = undefined;
    ctx.ui.setStatus("pi-cloud", undefined);
    ctx.ui.setWidget("pi-cloud", [
      snapshot.status === "completed"
        ? tr("cloud.resultAvailable", { taskId: task.state.taskId })
        : (snapshot.result?.error ??
          tr(`task.${snapshot.status}` as "task.failed")),
      task.state.artifactId ?? tr("cloud.resultMissing"),
      tr("cloud.resultActions"),
    ]);
    pi.appendEntry("pi-cloud-task", task.state);
    void persistTask(task.state);
  };

  const applySnapshot = (
    task: ActiveTask,
    snapshot: TaskSnapshot,
    ctx: ExtensionContext,
  ): void => {
    if (TERMINAL.has(snapshot.status)) finishTask(task, snapshot, ctx);
    else {
      task.state.status = snapshot.status;
      task.state.cursor = Math.max(task.state.cursor, snapshot.cursor);
      task.accepted = snapshot.status === "running";
      void persistTask(task.state);
    }
  };

  const handleFrame = (
    task: ActiveTask,
    frame:
      | ClientFrame
      | Exclude<import("./protocol.js").ProtocolFrame, ClientFrame>,
    ctx: ExtensionContext,
  ): void => {
    if (frame.type === "task_accepted" && frame.taskId === task.state.taskId) {
      task.accepted = frame.status === "running";
      task.state.status = frame.status;
      void persistTask(task.state);
      return;
    }
    if (
      frame.type === "task_event" &&
      frame.event.taskId === task.state.taskId
    ) {
      const event = frame.event;
      task.state.cursor = Math.max(task.state.cursor, event.cursor);
      if (typeof event.payload.status === "string") {
        task.state.status = event.payload.status as TaskStatus;
        task.accepted = event.payload.status === "running";
      }
      if (typeof event.payload.resultArtifactId === "string")
        task.state.artifactId = event.payload.resultArtifactId;
      if (typeof event.payload.sessionArtifactId === "string")
        task.state.sessionArtifactId = event.payload.sessionArtifactId;
      displayEvent(ctx, event, tr);
      pi.appendEntry("pi-cloud-live", { taskId: task.state.taskId, event });
      void persistTask(task.state);
      if (TERMINAL.has(task.state.status)) {
        const status = task.state.status;
        if (status === "queued" || status === "running") return;
        applySnapshot(
          task,
          {
            taskId: task.state.taskId,
            status,
            cursor: task.state.cursor,
            result: {
              taskId: task.state.taskId,
              status,
              ...(task.state.artifactId
                ? { resultArtifactId: task.state.artifactId }
                : {}),
              ...(task.state.sessionArtifactId
                ? { sessionArtifactId: task.state.sessionArtifactId }
                : {}),
              ...(typeof event.payload.error === "string"
                ? { error: event.payload.error }
                : {}),
            },
          },
          ctx,
        );
      }
      return;
    }
    if (
      frame.type === "task_state" &&
      frame.state.taskId === task.state.taskId
    ) {
      applySnapshot(task, frame.state, ctx);
      return;
    }
    if (
      frame.type === "task_result" &&
      frame.result.taskId === task.state.taskId
    ) {
      if (TERMINAL.has(frame.result.status))
        finishTask(
          task,
          {
            taskId: task.state.taskId,
            status: frame.result.status,
            cursor: task.state.cursor,
            result: frame.result,
          },
          ctx,
        );
      else {
        completeFromResult(task, frame.result);
        void persistTask(task.state);
      }
      return;
    }
    if (frame.type === "error")
      ctx.ui.notify(
        String(frame.error.params?.message ?? frame.error.code),
        "error",
      );
  };

  const scheduleReconnect = (task: ActiveTask, ctx: ExtensionContext): void => {
    if (task.reconnectTimer || shuttingDown || TERMINAL.has(task.state.status))
      return;
    const delay = Math.min(30_000, 1_000 * 2 ** task.reconnectAttempt++);
    task.reconnectTimer = setTimeout(() => {
      delete task.reconnectTimer;
      void connectTask(task, ctx).catch(() => scheduleReconnect(task, ctx));
    }, delay);
  };

  const connectTask = async (
    task: ActiveTask,
    ctx: ExtensionContext,
    announce = false,
    resume = true,
  ): Promise<void> => {
    task.socket?.close();
    task.socket = await task.connection.openEvents((frame) =>
      handleFrame(task, frame, ctx),
    );
    task.reconnectAttempt = 0;
    task.connection.send(task.socket, {
      type: "hello",
      protocolVersion: 1,
      clientId: task.state.sessionId,
    });
    if (resume) {
      if (task.state.status === "queued" && !task.accepted)
        task.connection.send(task.socket, {
          type: "task_status",
          taskId: task.state.taskId,
        });
      else
        task.connection.send(task.socket, {
          type: "task_resume",
          taskId: task.state.taskId,
          afterCursor: task.state.cursor,
        });
    }
    task.socket.on("close", () => {
      if (active?.state.taskId !== task.state.taskId || shuttingDown) return;
      task.socket = undefined;
      if (TERMINAL.has(task.state.status)) return;
      ctx.ui.setStatus("pi-cloud", tr("cloud.disconnectedRunning"));
      scheduleReconnect(task, ctx);
      void persistTask(task.state);
    });
    task.accepted = task.state.status === "running";
    if (announce) ctx.ui.notify(tr("cloud.reconnected"), "info");
  };

  pi.registerCommand("cloud-pair", {
    description: tr("cloud.pairDescription"),
    handler: async (args, ctx) => {
      let input = parsePairArgs(args);
      if (!input && ctx.hasUI) {
        const line = await ctx.ui.input(
          tr("cloud.pairLinePrompt"),
          "/cloud-pair https://127.0.0.1:9443 SHA256_FINGERPRINT ONE_TIME_CODE",
        );
        input = line ? parsePairArgs(line) : undefined;
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
        ctx.ui.notify(
          tr("cloud.paired", { workerId: paired.workerId }),
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          message === "CERTIFICATE_MISMATCH"
            ? tr("pair.certificateUntrusted")
            : formatNetworkError(error, input.baseUrl, tr),
          "error",
        );
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
        ...(state.activeWorkerId === selected.record.workerId
          ? {}
          : { activeWorkerId: state.activeWorkerId }),
      };
      await persistState();
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
      if (!active.socket) {
        ctx.ui.notify(tr("cloud.notConnected"), "warning");
        return;
      }
      active.connection.send(active.socket, {
        type: "task_abort",
        taskId: active.state.taskId,
      });
      ctx.ui.notify(tr("cloud.abortRequested"), "info");
    },
  });

  pi.registerCommand("cloud-submit", {
    description: tr("cloud.submitDescription"),
    handler: async (args, ctx) => {
      if (active) {
        ctx.ui.notify(
          tr("cloud.taskActive", { taskId: active.state.taskId }),
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
      const items: SyncPreflightItem[] = [
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
      if (authData)
        items.push({
          id: "credentials",
          label: tr("cloud.credentialsLabel"),
          description: tr("cloud.credentialsDescription"),
          selected: false,
        });
      const chosen = await selectSyncItems(ctx, items, {
        title: tr("cloud.preflightTitle"),
        required: tr("cloud.required"),
        upload: tr("cloud.upload"),
        cancel: tr("cloud.cancel"),
        help: tr("cloud.preflightHelp"),
        empty: tr("cloud.preflightEmpty"),
      });
      if (!chosen) {
        ctx.ui.notify(tr("cloud.cancelled"), "info");
        return;
      }
      const payloads = [
        {
          selectionId: "environment",
          id: `${taskId}-environment`,
          kind: "environment" as const,
          data: environmentData,
          contentType: "application/json",
        },
        {
          selectionId: "git",
          id: `${taskId}-git`,
          kind: "workspace" as const,
          data: gitData,
          contentType: "application/json",
        },
        {
          selectionId: "session",
          id: `${taskId}-session`,
          kind: "session" as const,
          data: sessionData,
          contentType: "application/jsonl",
        },
      ].filter((payload) => chosen.has(payload.selectionId));
      const emptyEnvironment = {
        ...manifest,
        packages: [],
        resources: [],
        providers: [],
        secretVersions: [],
      };
      const task: TaskSpec = {
        taskId,
        projectId: ctx.cwd,
        prompt,
        runner: "docker",
        environment: chosen.has("environment") ? manifest : emptyEnvironment,
        git: workspace.snapshot.baseline,
        session: chosen.has("session")
          ? {
              sessionId: archive.header.id,
              baseLeafId: archive.leafId,
              lastEntryId: archive.leafId,
              entriesSha256: archive.entriesSha256,
            }
          : {
              sessionId: randomUUID(),
              baseLeafId: null,
              lastEntryId: null,
              entriesSha256: sha256(""),
            },
        artifacts: payloads.map((payload) => ({
          id: payload.id,
          kind: payload.kind,
          size: payload.data.byteLength,
          sha256: sha256(payload.data),
          contentType: payload.contentType,
        })),
        secretIds: chosen.has("credentials") ? ["pi-auth"] : [],
      };
      const sessionTask: CloudTaskState = {
        taskId,
        workerId: selected.record.workerId,
        baseUrl: selected.record.baseUrl,
        fingerprint: selected.record.fingerprint,
        projectId: ctx.cwd,
        sessionId: task.session.sessionId,
        baseLeafId: task.session.baseLeafId,
        lastEntryId: task.session.lastEntryId,
        entriesSha256: task.session.entriesSha256,
        cursor: 0,
        status: "queued",
        prompt,
        updatedAt: new Date().toISOString(),
      };
      active = {
        state: sessionTask,
        accepted: false,
        socket: undefined,
        connection: selected.connection,
        reconnectAttempt: 0,
      };
      await persistTask(sessionTask);
      let submitted = false;
      try {
        if (chosen.has("credentials") && authData)
          await selected.connection.uploadSecret(
            "pi-auth",
            authData.toString("utf8"),
          );
        for (const payload of payloads) {
          ctx.ui.setStatus(
            "pi-cloud",
            `${tr("cloud.uploading")} · ${payload.selectionId}`,
          );
          await selected.connection.upload(
            payload.id,
            payload.data,
            payload.contentType,
          );
        }
        ctx.ui.setStatus("pi-cloud", tr("cloud.connecting"));
        await connectTask(active, ctx, false, false);
        if (!active.socket) throw new Error("WebSocket did not open");
        selected.connection.send(active.socket, { type: "task_create", task });
        submitted = true;
        ctx.ui.notify(tr("cloud.started", { taskId }), "info");
      } catch (error) {
        const failedTask = active;
        if (submitted) {
          if (failedTask?.socket) failedTask.socket.close();
          if (failedTask) scheduleReconnect(failedTask, ctx);
          ctx.ui.setStatus("pi-cloud", tr("cloud.disconnectedRunning"));
        } else {
          active = undefined;
          state = {
            ...state,
            tasks: (state.tasks ?? []).filter((item) => item.taskId !== taskId),
          };
          await persistState();
          ctx.ui.setStatus("pi-cloud", undefined);
        }
        ctx.ui.notify(
          formatNetworkError(error, selected.record.baseUrl, tr),
          submitted ? "warning" : "error",
        );
      }
    },
  });

  pi.registerCommand("cloud-reconnect", {
    description: tr("cloud.reconnectDescription"),
    handler: async (_args, ctx) => {
      if (!active) {
        ctx.ui.notify(tr("cloud.noTask"), "info");
        return;
      }
      try {
        await connectTask(active, ctx, true);
      } catch (error) {
        ctx.ui.setStatus("pi-cloud", tr("cloud.disconnectedRunning"));
        scheduleReconnect(active, ctx);
        ctx.ui.notify(
          formatNetworkError(error, active.state.baseUrl, tr),
          "warning",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const task = (state.tasks ?? [])
      .filter(
        (item) =>
          item.projectId === ctx.cwd &&
          item.sessionId === ctx.sessionManager.getSessionId(),
      )
      .at(-1);
    if (!task) return;
    shuttingDown = false;
    const selected = connectionFor(task.workerId);
    if (!selected) return;
    lastResult = task.artifactId || task.sessionArtifactId ? task : undefined;
    if (TERMINAL.has(task.status)) {
      ctx.ui.setWidget("pi-cloud", [
        tr("cloud.resultAvailable", { taskId: task.taskId }),
        task.artifactId ?? tr("cloud.resultMissing"),
        tr("cloud.resultActions"),
      ]);
      return;
    }
    active = {
      state: task,
      accepted: task.status === "running",
      socket: undefined,
      connection: selected.connection,
      reconnectAttempt: 0,
    };
    try {
      await connectTask(active, ctx);
      ctx.ui.notify(tr("cloud.restored", { taskId: task.taskId }), "info");
    } catch (error) {
      ctx.ui.setStatus("pi-cloud", tr("cloud.disconnectedRunning"));
      scheduleReconnect(active, ctx);
      ctx.ui.notify(formatNetworkError(error, task.baseUrl, tr), "warning");
    }
  });

  pi.registerCommand("cloud-apply", {
    description: tr("cloud.applyDescription"),
    handler: async (args, ctx) => {
      const task =
        lastResult ??
        (state.tasks ?? [])
          .filter((item) => item.projectId === ctx.cwd && item.artifactId)
          .at(-1);
      const selected = task ? connectionFor(task.workerId) : connectionFor();
      const artifactId = args.trim() || task?.artifactId;
      if (!selected || !artifactId) {
        ctx.ui.notify(tr("cloud.resultMissing"), "warning");
        return;
      }
      try {
        const snapshot = parseGitSnapshot(
          (await selected.connection.download(artifactId)).toString("utf8"),
        );
        const choice = ctx.hasUI
          ? await ctx.ui.confirm(
              tr("cloud.applyConfirm"),
              snapshot.files
                .map((file) => `${file.status} ${file.path}`)
                .join("\n"),
            )
          : false;
        if (!choice) return;
        const changed = await applyGitSnapshot(ctx.cwd, snapshot);
        ctx.ui.notify(tr("cloud.applied", { count: changed.length }), "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerCommand("cloud-merge", {
    description: tr("cloud.mergeDescription"),
    handler: async (args, ctx) => {
      const task =
        lastResult ??
        (state.tasks ?? [])
          .filter(
            (item) => item.projectId === ctx.cwd && item.sessionArtifactId,
          )
          .at(-1);
      const selected = task ? connectionFor(task.workerId) : connectionFor();
      const artifactId = args.trim() || task?.sessionArtifactId;
      if (!selected || !task || !artifactId) {
        ctx.ui.notify(tr("cloud.sessionResultMissing"), "warning");
        return;
      }
      try {
        const source = exportSessionBranch(ctx.sessionManager);
        const remote = parseSessionArchive(
          (await selected.connection.download(artifactId)).toString("utf8"),
        );
        const merged = mergeSessionTail(source, remote, {
          sessionId: task.sessionId,
          baseLeafId: task.baseLeafId,
          lastEntryId: task.lastEntryId,
          entriesSha256: task.entriesSha256,
        });
        const path = join(
          ctx.cwd,
          ".pi",
          `cloud-merged-${merged.header.id}.jsonl`,
        );
        await writeMergedSession(path, merged);
        const switched = await ctx.switchSession(path);
        if (!switched.cancelled) ctx.ui.notify(tr("cloud.merged"), "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });

  pi.registerCommand("cloud-status", {
    description: tr("cloud.statusDescription"),
    handler: async (_args, ctx) => {
      const selected = connectionFor();
      const task = active?.state ?? lastResult;
      const lines = selected
        ? [
            tr("cloud.connected", {
              address: selected.record.baseUrl,
              workerId: selected.record.workerId,
            }),
            task
              ? tr(`cloud.task.${task.status}` as "cloud.task.running", {
                  taskId: task.taskId,
                  cursor: task.cursor,
                })
              : tr("cloud.idleStatus"),
            task?.artifactId
              ? tr("cloud.resultAvailable", { taskId: task.taskId })
              : "",
          ].filter(Boolean)
        : [tr("cloud.disconnected")];
      ctx.ui.setWidget("pi-cloud", lines);
      ctx.ui.notify(
        lines[0] ?? tr("cloud.disconnected"),
        selected ? "info" : "warning",
      );
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
      const selected = ctx.hasUI
        ? await ctx.ui.select(tr("cloud.languageChoice"), [
            "简体中文",
            "English",
          ])
        : undefined;
      if (!selected) return;
      locale = selected === "简体中文" ? "zh-CN" : "en";
      state = { ...state, locale };
      await persistState();
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
      const sendCommand = (value: string) =>
        pi.sendUserMessage(value, {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        });
      if (commandMap[command]) {
        sendCommand(commandMap[command]);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(tr("cloud.helpText"), "info");
        return;
      }
      const selected = connectionFor();
      const task = active?.state ?? lastResult;
      const status = selected
        ? [
            tr("cloud.connected", {
              address: selected.record.baseUrl,
              workerId: selected.record.workerId,
            }),
            task
              ? tr(`cloud.task.${task.status}` as "cloud.task.running", {
                  taskId: task.taskId,
                  cursor: task.cursor,
                })
              : tr("cloud.idleStatus"),
          ]
        : [tr("cloud.disconnected")];
      const items: CloudMenuItem[] = [];
      if (!selected)
        items.push({
          value: "pair",
          label: tr("cloud.pairChoice"),
          description: tr("cloud.pairDescription"),
        });
      else if (active) {
        items.push({
          value: "status",
          label: tr("cloud.statusChoice"),
          description: tr(`cloud.task.${active.state.status}` as "cloud.task.running", {
            taskId: active.state.taskId,
            cursor: active.state.cursor,
          }),
        });
        items.push({
          value: "reconnect",
          label: tr("cloud.reconnectChoice"),
          description: tr("cloud.reconnectDescription"),
        });
        items.push({
          value: "abort",
          label: tr("cloud.abortChoice"),
          description: tr("cloud.abortDescription"),
        });
      } else {
        items.push({
          value: "submit",
          label: tr("cloud.submitChoice"),
          description: tr("cloud.submitDescription"),
        });
        if (lastResult?.artifactId)
          items.push({
            value: "apply",
            label: tr("cloud.applyChoice"),
            description: tr("cloud.applyDescription"),
          });
        if (lastResult?.sessionArtifactId)
          items.push({
            value: "merge",
            label: tr("cloud.mergeChoice"),
            description: tr("cloud.mergeDescription"),
          });
        items.push({
          value: "status",
          label: tr("cloud.statusChoice"),
          description: tr("cloud.statusDescription"),
        });
        items.push({
          value: "unpair",
          label: tr("cloud.unpairChoice"),
          description: tr("cloud.unpairDescription"),
        });
      }
      items.push({
        value: "help",
        label: tr("cloud.helpChoice"),
        description: tr("cloud.helpDescription"),
      });
      items.push({
        value: "language",
        label: tr("cloud.languageChoice"),
        description: tr("cloud.languageDescription"),
      });
      const choice = await selectCloudMenu(
        ctx,
        tr("cloud.menu"),
        status,
        items,
        tr("cloud.menuHelp"),
      );
      if (choice && commandMap[choice]) sendCommand(commandMap[choice]);
    },
  });

  pi.on("input", (event, ctx) => {
    if (!active || event.source === "extension" || event.text.startsWith("/"))
      return { action: "continue" as const };
    if (!active.socket || !active.accepted) {
      ctx.ui.notify(tr("cloud.notConnected"), "warning");
      return { action: "handled" as const };
    }
    active.connection.send(active.socket, {
      type: "task_input",
      input: {
        taskId: active.state.taskId,
        delivery: event.streamingBehavior ?? "followUp",
        message: event.text,
      },
    } satisfies ClientFrame);
    return { action: "handled" as const };
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    if (active?.reconnectTimer) clearTimeout(active.reconnectTimer);
    active?.socket?.close();
    active = undefined;
  });
}
