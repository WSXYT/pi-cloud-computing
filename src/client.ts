import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";

import { buildEnvironmentManifest } from "./environment.js";
import { detectLocale, translate } from "./i18n.js";
import { createGitSnapshot, parseGitSnapshot } from "./git.js";
import {
  exportSessionBranch,
  mergeSessionTail,
  parseSessionArchive,
  serializeSessionArchive,
  writeMergedSession,
} from "./session.js";
import type { ClientFrame, TaskEvent, TaskSpec } from "./protocol.js";
import { applyGitSnapshot } from "./result.js";
import { CloudConnection } from "./client-network.js";
import {
  loadClientState,
  saveClientState,
  type CloudClientState,
  type CloudConnectionState,
} from "./client-state.js";

interface ActiveTask {
  taskId: string;
  cursor: number;
  socket: WebSocket;
  connection: CloudConnection;
}

interface LastResult {
  connection: CloudConnection;
  artifactId: string;
  sessionArtifactId?: string;
}

const PI_VERSION = "0.84.2";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function displayEvent(ctx: ExtensionContext, event: TaskEvent): void {
  const status =
    typeof event.payload.status === "string"
      ? event.payload.status
      : event.kind;
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
  const [baseUrl, fingerprint, code] = args.trim().split(/\s+/);
  return baseUrl && fingerprint && code
    ? { baseUrl, fingerprint, code }
    : undefined;
}

export default async function piCloudExtension(
  pi: ExtensionAPI,
): Promise<void> {
  let state: CloudClientState = await loadClientState();
  const locale = detectLocale(state.locale);
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
          "Worker HTTPS URL",
          "https://127.0.0.1:9443",
        );
        const fingerprint = await ctx.ui.input(
          "Certificate SHA-256 fingerprint",
          "AA:BB:...",
        );
        const code = await ctx.ui.input("One-time pairing code", "");
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
      const paired = await connection.pair(input.code);
      await saveConnection({
        baseUrl: connection.baseUrl,
        workerId: paired.workerId,
        fingerprint: paired.certificateFingerprint,
        token: paired.token,
        pairedAt: new Date().toISOString(),
      });
      ctx.ui.notify(tr("cloud.paired", { workerId: paired.workerId }), "info");
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
              "Continue the current task",
            )
          : "Continue the current task");
      if (!prompt) return;
      const archive = exportSessionBranch(ctx.sessionManager);
      const git = await createGitSnapshot(ctx.cwd);
      const manifest = await buildEnvironmentManifest({
        agentDir: agentDir(),
        cwd: ctx.cwd,
        piVersion: PI_VERSION,
        nodeVersion: process.version,
        platform: platform(),
      });
      const taskId = randomUUID();
      const items = [
        `environment manifest (${manifest.resources.length} resources, ${manifest.providers.length} providers)`,
        `Git snapshot (${git.files.length} changed files)`,
        `session branch (${archive.entries.length} entries)`,
      ];
      const approved = ctx.hasUI
        ? await ctx.ui.select(tr("cloud.syncConfirm"), [...items, "Cancel"])
        : "Cancel";
      if (approved === "Cancel" || !approved) {
        ctx.ui.notify(tr("cloud.cancelled"), "info");
        return;
      }
      const task: TaskSpec = {
        taskId,
        projectId: ctx.cwd,
        prompt,
        runner: "docker",
        environment: manifest,
        git: git.baseline,
        session: {
          sessionId: archive.header.id,
          baseLeafId: archive.entries.at(-1)?.id ?? null,
          lastEntryId: archive.entries.at(-1)?.id ?? null,
          entriesSha256: archive.entriesSha256,
        },
        artifacts: [
          {
            id: `${taskId}-environment`,
            kind: "environment",
            size: Buffer.byteLength(JSON.stringify(manifest)),
            sha256: "pending",
            contentType: "application/json",
          },
          {
            id: `${taskId}-git`,
            kind: "workspace",
            size: Buffer.byteLength(JSON.stringify(git)),
            sha256: "pending",
            contentType: "application/json",
          },
          {
            id: `${taskId}-session`,
            kind: "session",
            size: Buffer.byteLength(serializeSessionArchive(archive)),
            sha256: "pending",
            contentType: "application/jsonl",
          },
        ],
        secretIds: [],
      };
      await selected.connection.upload(
        `${taskId}-environment`,
        Buffer.from(JSON.stringify(manifest)),
        "application/json",
      );
      await selected.connection.upload(
        `${taskId}-git`,
        Buffer.from(JSON.stringify(git)),
        "application/json",
      );
      await selected.connection.upload(
        `${taskId}-session`,
        Buffer.from(serializeSessionArchive(archive)),
        "application/jsonl",
      );
      const socket = await selected.connection.openEvents((frame) => {
        if (frame.type !== "task_event" || frame.event.taskId !== taskId)
          return;
        active && (active.cursor = frame.event.cursor);
        displayEvent(ctx, frame.event);
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
      active = { taskId, cursor: 0, socket, connection: selected.connection };
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
        displayEvent(ctx, frame.event);
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
    description: "Review and apply a remote Git result artifact",
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
            "Cancel",
          ])
        : "Cancel";
      if (choice === "Cancel" || !choice) return;
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

  pi.registerCommand("cloud-sponsor", {
    description: tr("recommendation.sponsorPlaceholder"),
    handler: async (_args, ctx) =>
      ctx.ui.notify(tr("recommendation.sponsorPlaceholder"), "info"),
  });

  pi.registerCommand("cloud", {
    description: tr("cloud.menu"),
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "pair")
        return pi.sendUserMessage("/cloud-pair", { deliverAs: "followUp" });
      if (command === "submit")
        return pi.sendUserMessage("/cloud-submit", { deliverAs: "followUp" });
      if (command === "abort")
        return pi.sendUserMessage("/cloud-abort", { deliverAs: "followUp" });
      if (!ctx.hasUI) {
        ctx.ui.notify(tr("cloud.menu"), "info");
        return;
      }
      const choice = await ctx.ui.select(tr("cloud.menu"), [
        tr("cloud.submitChoice"),
        tr("cloud.pairChoice"),
        tr("cloud.abortChoice"),
        tr("cloud.unpairChoice"),
      ]);
      if (choice === tr("cloud.submitChoice"))
        pi.sendUserMessage("/cloud-submit", { deliverAs: "followUp" });
      else if (choice === tr("cloud.pairChoice"))
        pi.sendUserMessage("/cloud-pair", { deliverAs: "followUp" });
      else if (choice === tr("cloud.abortChoice"))
        pi.sendUserMessage("/cloud-abort", { deliverAs: "followUp" });
      else if (choice === tr("cloud.unpairChoice"))
        pi.sendUserMessage("/cloud-unpair", { deliverAs: "followUp" });
    },
  });

  pi.on("input", (event) => {
    if (!active || event.source === "extension" || event.text.startsWith("/"))
      return { action: "continue" as const };
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
