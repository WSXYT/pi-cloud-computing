import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  VERSION, formatSize, generateUnifiedPatch, getAgentDir, getMarkdownTheme, truncateHead, withFileMutationQueue,
  type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import type WebSocket from "ws";

import { sha256 } from "./environment.js";
import { scanEnvironment } from "./environment-archive.js";
import { detectLocale, translate, type MessageKey } from "./i18n.js";
import { assertGitRepository, createGitSnapshot, createWorkspaceArchive, currentGitMatches, parseGitSnapshot, repositoryRoot, serializeWorkspaceArchive } from "./git.js";
import { exportSessionBranch, mergeSessionTail, parseSessionArchive, serializeSessionArchive, writeMergedSession } from "./session.js";
import { parseTaskInput, parseTaskUiRequest, type ProtocolFrame, type SessionCursor, type TaskResult, type TaskSnapshot, type TaskSpec, type TaskStatus, type TaskUiRequest, type TaskUiResponse } from "./protocol.js";
import { applyGitSnapshot } from "./result.js";
import { safeFilePath, validateIdentifier } from "./paths.js";
import { writePrivateFile } from "./storage.js";
import { CloudConnection, normalizeFingerprint } from "./client-network.js";
import { remoteEventView, safeDisplayText } from "./client-events.js";
import { selectSyncItems, type SyncPreflightItem } from "./client-preflight.js";
import { selectCloudMenu, type CloudMenuItem } from "./client-menu.js";
import { loadClientState, updateClientState, type CloudClientState, type CloudTaskState } from "./client-state.js";
import { PROTOCOL_VERSION } from "./version.js";

interface ActiveTask {
  state: CloudTaskState;
  connection: CloudConnection;
  socket: WebSocket | undefined;
  generation: number;
  accepted: boolean;
  reconnectAttempt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  retryBlocked: boolean;
  preview: string;
  seen: Set<number>;
  sentInputs: Set<string>;
  uiSeen: Set<string>;
  uiQueue: Promise<void>;
  uiAbort: AbortController;
  pendingSnapshot?: TaskSnapshot;
}
const TERMINAL = new Set<TaskStatus>(["completed", "failed", "aborted"]);
const isTerminal = (task: CloudTaskState) => TERMINAL.has(task.status) && !task.finalizing;
const detail = (error: unknown) => safeDisplayText(error instanceof Error ? error.message : String(error));
const sameProject = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function artifactId(kind: "environment" | "workspace" | "session", data: Uint8Array): string {
  return `${kind}-${sha256(data)}`;
}

function parsePairLine(value: string): [string, string, string] | undefined {
  const parts = value.trim().replace(/^\/cloud-pair\s+/, "").split(/\s+/);
  return parts.length === 3 && parts.every(Boolean) ? parts as [string, string, string] : undefined;
}

function nativeSessionPath(directory: string, id: string): string {
  validateIdentifier(id);
  return join(directory, `${new Date(Date.now() + 1).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
}

export default async function piCloudExtension(pi: ExtensionAPI): Promise<void> {
  let state = await loadClientState();
  let locale = detectLocale(state.locale);
  const tr = (key: MessageKey, params: Record<string, string | number> = {}) => translate(locale, key, params);
  let active: ActiveTask | undefined;
  let lastResult: CloudTaskState | undefined;
  let shuttingDown = false;
  let submitting = false;
  let wizardOpen = false;
  let saveWarning = false;
  const dirtyTasks = new Map<string, CloudTaskState>();
  const stateUpdates: Array<(value: CloudClientState) => CloudClientState> = [];
  let persistence: Promise<void> | undefined;

  // Coalesce streaming checkpoints, and merge under a cross-process lock instead of overwriting other Pi sessions' tasks.
  const persistState = (update?: (value: CloudClientState) => CloudClientState): Promise<void> => {
    if (update) stateUpdates.push(update);
    if (!persistence) {
      persistence = (async () => {
        while (dirtyTasks.size || stateUpdates.length) {
          const pending = new Map(dirtyTasks);
          dirtyTasks.clear();
          const updates = stateUpdates.splice(0);
          try {
            const saved = await updateClientState((value) => {
              for (const change of updates) value = change(value);
              return { ...value, tasks: [...(value.tasks ?? []).filter((task) => !pending.has(task.taskId)), ...pending.values()] };
            });
            state = { ...saved, tasks: [...(saved.tasks ?? []).filter((task) => !dirtyTasks.has(task.taskId)), ...dirtyTasks.values()] };
            saveWarning = false;
          } catch (error) {
            for (const [id, task] of pending) if (!dirtyTasks.has(id)) dirtyTasks.set(id, task);
            stateUpdates.unshift(...updates);
            throw error;
          }
        }
      })().finally(() => { persistence = undefined; });
    }
    return persistence;
  };
  const persistTask = (task: CloudTaskState): Promise<void> => {
    task.updatedAt = new Date().toISOString();
    state.tasks = [...(state.tasks ?? []).filter((item) => item.taskId !== task.taskId), task];
    dirtyTasks.set(task.taskId, task);
    return persistState();
  };
  const checkpoint = (task: CloudTaskState, ctx: ExtensionContext): void => {
    void persistTask(task).catch((error: unknown) => {
      const code = error && typeof error === "object" && "code" in error
        ? safeDisplayText(`${String(error.code)}${"syscall" in error ? `: ${String(error.syscall)}` : ""}`) : "STATE_WRITE_FAILED";
      if (!saveWarning) ctx.ui.notify(`${tr("cloud.stateError")} (${code})`, "error");
      saveWarning = true;
    });
  };
  const connectionFor = (workerId = state.activeWorkerId) => {
    const record = state.connections.find((item) => item.workerId === workerId);
    return record ? { record, connection: new CloudConnection(record.baseUrl, record.fingerprint, record.token) } : undefined;
  };
  const tasksFor = (ctx: ExtensionContext) => (state.tasks ?? []).filter((task) => sameProject(task.projectId, ctx.cwd));
  const resultTask = (ctx: ExtensionContext, field: "artifactId" | "sessionArtifactId", id = "") => {
    if (id.trim()) return tasksFor(ctx).findLast((task) => task[field] === id.trim());
    return lastResult?.[field] ? lastResult : tasksFor(ctx).findLast((task) => !!task[field]);
  };
  const requireIdle = (ctx: ExtensionContext): void => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error(tr("cloud.localBusy"));
  };
  const statusText = (task: CloudTaskState) => task.finalizing ? tr("cloud.stopping") : tr(`cloud.task.${task.status}`, { taskId: task.taskId, cursor: task.cursor });
  const showTask = (task: ActiveTask, ctx: ExtensionContext): void => {
    ctx.ui.setStatus("pi-cloud", statusText(task.state));
    ctx.ui.setWidget("pi-cloud", [
      `☁ Pi Cloud · ${statusText(task.state)}`,
      ...safeDisplayText(task.preview).split("\n").slice(-8),
      ...(task.state.pendingInputs?.length ? [tr("cloud.pendingInputs", { count: task.state.pendingInputs.length })] : []),
      tr("cloud.liveHelp"),
    ]);
  };
  const showResult = (task: CloudTaskState, ctx: ExtensionContext): void => {
    ctx.ui.setStatus("pi-cloud", undefined);
    ctx.ui.setWidget("pi-cloud", [
      statusText(task), ...(task.error ? [safeDisplayText(task.error)] : []),
      ...(task.artifactId ? [task.artifactId] : []),
      ...(task.artifactId || task.sessionArtifactId ? [tr("cloud.resultActions")] : []),
      ...(task.pendingInputs?.length ? [tr("cloud.pendingInputWarning", { count: task.pendingInputs.length })] : []),
    ]);
  };
  const disconnect = (task: ActiveTask): void => {
    task.generation++;
    if (task.reconnectTimer) clearTimeout(task.reconnectTimer);
    delete task.reconnectTimer;
    task.uiAbort.abort();
    task.socket?.terminate();
    task.socket = undefined;
    task.accepted = false;
  };
  const completeFromResult = (task: ActiveTask, result: TaskResult): void => {
    task.state.status = result.status;
    if (result.resultArtifactId) task.state.artifactId = result.resultArtifactId;
    if (result.sessionArtifactId) task.state.sessionArtifactId = result.sessionArtifactId;
    if (result.error) task.state.error = result.error;
  };
  const finishTask = (task: ActiveTask, snapshot: TaskSnapshot, ctx: ExtensionContext): void => {
    if (active !== task) return;
    task.state.status = snapshot.status;
    task.state.finalizing = false;
    if (snapshot.result) completeFromResult(task, snapshot.result);
    lastResult = task.state;
    disconnect(task);
    active = undefined;
    pi.appendEntry("pi-cloud-task", { taskId: task.state.taskId, status: task.state.status });
    checkpoint(task.state, ctx);
    showResult(task.state, ctx);
  };
  const sendOutbox = (task: ActiveTask): void => {
    if (!task.socket || task.socket.readyState !== 1 || !task.accepted) return;
    if (task.state.pendingAbort) {
      task.connection.send(task.socket, { type: "task_abort", taskId: task.state.taskId });
      return;
    }
    if (TERMINAL.has(task.state.status)) return;
    for (const input of task.state.pendingInputs ?? []) {
      if (input.id && task.sentInputs.has(input.id)) continue;
      task.connection.send(task.socket, { type: "task_input", input });
      if (input.id) task.sentInputs.add(input.id);
    }
  };
  const requestUi = (task: ActiveTask, request: TaskUiRequest, ctx: ExtensionContext): void => {
    if (task.uiSeen.has(request.id)) return;
    task.uiSeen.add(request.id);
    const generation = task.generation;
    task.uiQueue = task.uiQueue.then(async () => {
      if (active !== task || generation !== task.generation) return;
      const title = tr("cloud.remoteDialog", { title: safeDisplayText(request.title) });
      const response: TaskUiResponse = { taskId: task.state.taskId, id: request.id };
      if (!ctx.hasUI) response.cancelled = true;
      else if (request.method === "confirm") response.confirmed = await ctx.ui.confirm(title, safeDisplayText(request.message ?? ""), { signal: task.uiAbort.signal });
      else if (request.method === "select") {
        const labels = (request.options ?? []).map((option, index) => `${index + 1}. ${safeDisplayText(option)}`);
        const selected = await ctx.ui.select(title, labels, { signal: task.uiAbort.signal });
        const index = selected === undefined ? -1 : labels.indexOf(selected);
        if (index < 0) response.cancelled = true;
        else response.value = request.options![index]!;
      } else {
        const value = request.method === "editor"
          ? await ctx.ui.editor(title, safeDisplayText(request.prefill ?? ""))
          : await ctx.ui.input(title, safeDisplayText(request.placeholder ?? ""), { signal: task.uiAbort.signal });
        if (value === undefined) response.cancelled = true;
        else response.value = value;
      }
      if (active === task && generation === task.generation && task.socket?.readyState === 1)
        task.connection.send(task.socket, { type: "task_ui_response", response });
    }).catch((error: unknown) => { if (!task.uiAbort.signal.aborted) ctx.ui.notify(detail(error), "error"); });
  };
  const resumeTail = (task: ActiveTask): void => {
    if (task.socket?.readyState === 1) task.connection.send(task.socket, { type: "task_resume", taskId: task.state.taskId, afterCursor: task.state.cursor });
  };
  const applySnapshot = (task: ActiveTask, snapshot: TaskSnapshot, ctx: ExtensionContext): void => {
    task.state.status = snapshot.status;
    task.state.finalizing = snapshot.finalizing === true || (TERMINAL.has(snapshot.status) && snapshot.cursor > task.state.cursor);
    if (TERMINAL.has(snapshot.status)) delete task.state.pendingAbort;
    task.state.accepted = true;
    task.accepted = true;
    task.reconnectAttempt = 0;
    if (snapshot.result) completeFromResult(task, snapshot.result);
    for (const request of snapshot.uiRequests ?? []) requestUi(task, parseTaskUiRequest(request), ctx);
    if (TERMINAL.has(snapshot.status) && !snapshot.finalizing) {
      // A state cursor is a high-water mark, not proof that we rendered those events.
      if (snapshot.cursor > task.state.cursor) {
        const alreadyRequested = task.pendingSnapshot?.cursor === snapshot.cursor;
        task.pendingSnapshot = snapshot;
        if (!alreadyRequested) resumeTail(task);
      } else finishTask(task, snapshot, ctx);
    } else { sendOutbox(task); checkpoint(task.state, ctx); showTask(task, ctx); }
  };
  const handleFrame = (task: ActiveTask, frame: ProtocolFrame, ctx: ExtensionContext): void => {
    if (active !== task || shuttingDown) return;
    if (frame.type === "task_accepted" && frame.taskId === task.state.taskId) {
      const first = !task.state.accepted;
      task.state.accepted = true;
      task.accepted = true;
      task.state.status = frame.status;
      // An acknowledgement alone is not a final result or proof that the event tail was consumed.
      task.state.finalizing = TERMINAL.has(frame.status);
      if (TERMINAL.has(frame.status)) delete task.state.pendingAbort;
      task.reconnectAttempt = 0;
      if (first) ctx.ui.notify(tr("cloud.started", { taskId: task.state.taskId }), "info");
      checkpoint(task.state, ctx);
      sendOutbox(task);
    } else if (frame.type === "task_input_accepted" && frame.taskId === task.state.taskId) {
      task.state.pendingInputs = (task.state.pendingInputs ?? []).filter((input) => input.id !== frame.inputId);
      checkpoint(task.state, ctx);
      showTask(task, ctx);
    } else if (frame.type === "task_event" && frame.event.taskId === task.state.taskId) {
      const event = frame.event;
      if (event.cursor <= task.state.cursor) return;
      task.state.cursor = event.cursor;
      const view = remoteEventView(event);
      if (view.reset) task.preview = "";
      if (view.text !== undefined) task.preview = view.text;
      if (view.delta !== undefined) task.preview = safeDisplayText(task.preview + view.delta);
      if (view.transcript && !task.seen.has(event.cursor)) {
        task.seen.add(event.cursor);
        pi.appendEntry("pi-cloud-live", { taskId: event.taskId, cursor: event.cursor, text: view.transcript });
      }
      const rpc = event.payload.rpc as { type?: string; method?: string } | undefined;
      if (rpc?.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(rpc.method ?? ""))
        requestUi(task, parseTaskUiRequest(rpc), ctx);
      checkpoint(task.state, ctx);
      showTask(task, ctx);
      if (task.pendingSnapshot && task.state.cursor >= task.pendingSnapshot.cursor) finishTask(task, task.pendingSnapshot, ctx);
    } else if (frame.type === "task_state" && frame.state.taskId === task.state.taskId) {
      applySnapshot(task, frame.state, ctx);
    } else if (frame.type === "task_result" && frame.result.taskId === task.state.taskId) {
      completeFromResult(task, frame.result);
      task.state.finalizing = true;
      if (task.pendingSnapshot) task.pendingSnapshot.result = frame.result;
      else if (task.socket?.readyState === 1) task.connection.send(task.socket, { type: "task_status", taskId: task.state.taskId });
      checkpoint(task.state, ctx);
    } else if (frame.type === "error") {
      if (frame.error.code === "TASK_NOT_FOUND" && frame.requestType === "task_resume") {
        if (!task.state.accepted && task.state.readyToSubmit && task.state.spec && task.socket)
          task.connection.send(task.socket, { type: "task_create", task: task.state.spec });
        else finishTask(task, { taskId: task.state.taskId, status: "failed", cursor: task.state.cursor,
          result: { taskId: task.state.taskId, status: "failed", error: tr("cloud.unconfirmedTask") } }, ctx);
      } else {
        const message = String(frame.error.params?.message ?? frame.error.code);
        ctx.ui.notify(safeDisplayText(message), "error");
        if (frame.requestType === "task_create") finishTask(task, { taskId: task.state.taskId, status: "failed", cursor: task.state.cursor,
          result: { taskId: task.state.taskId, status: "failed", error: message } }, ctx);
      }
    }
  };
  const scheduleReconnect = (task: ActiveTask, ctx: ExtensionContext): void => {
    if (active !== task || task.reconnectTimer || shuttingDown || task.retryBlocked) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(6, task.reconnectAttempt++));
    task.reconnectTimer = setTimeout(() => {
      delete task.reconnectTimer;
      void connectTask(task, ctx).catch((error: unknown) => connectionFailed(task, ctx, error));
    }, delay);
    task.reconnectTimer.unref();
  };
  const connectionFailed = (task: ActiveTask, ctx: ExtensionContext, error: unknown): void => {
    if (active !== task || shuttingDown) return;
    task.retryBlocked = /CERTIFICATE_MISMATCH|AUTH_|401|403|invalid protocol/i.test(detail(error));
    ctx.ui.setStatus("pi-cloud", tr(task.retryBlocked ? "cloud.authRequired" : "cloud.disconnectedRunning"));
    if (task.retryBlocked) ctx.ui.notify(tr("cloud.authRequired"), "error");
    else scheduleReconnect(task, ctx);
  };
  const connectTask = async (task: ActiveTask, ctx: ExtensionContext, create = false): Promise<void> => {
    disconnect(task);
    const generation = task.generation;
    task.uiAbort = new AbortController();
    task.uiSeen.clear();
    task.sentInputs.clear();
    delete task.pendingSnapshot;
    const socket = await task.connection.openEvents((frame) => {
      if (active !== task || task.generation !== generation || shuttingDown) return;
      if (frame.type === "hello_ack") {
        if (frame.worker.workerId !== task.state.workerId) {
          task.retryBlocked = true;
          task.socket?.close(1003, "worker identity mismatch");
          ctx.ui.notify(tr("cloud.authRequired"), "error");
          return;
        }
        if (create && task.state.spec && task.state.readyToSubmit && task.socket)
          task.connection.send(task.socket, { type: "task_create", task: task.state.spec });
        else resumeTail(task);
      } else handleFrame(task, frame, ctx);
    });
    if (active !== task || generation !== task.generation || shuttingDown) { socket.terminate(); return; }
    task.socket = socket;
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      if (socket.readyState === 1) socket.ping();
    }, 15_000);
    heartbeat.unref();
    socket.on("close", (code) => {
      clearInterval(heartbeat);
      if (active !== task || task.generation !== generation || shuttingDown) return;
      task.socket = undefined;
      task.accepted = false;
      task.uiAbort.abort();
      connectionFailed(task, ctx, new Error(code === 4003 || code === 1003 ? "AUTH_REJECTED" : "disconnected"));
    });
    task.connection.send(socket, { type: "hello", protocolVersion: PROTOCOL_VERSION, clientId: task.state.sessionId });
  };
  const makeActive = (task: CloudTaskState, connection: CloudConnection, ctx: ExtensionContext): ActiveTask => {
    const seen = new Set<number>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "pi-cloud-live") continue;
      const data = entry.data as { taskId?: string; cursor?: number } | undefined;
      if (data?.taskId === task.taskId && typeof data.cursor === "number") seen.add(data.cursor);
    }
    return { state: task, connection, socket: undefined, generation: 0, accepted: false, reconnectAttempt: 0,
      retryBlocked: false, preview: "", seen, sentInputs: new Set(), uiSeen: new Set(), uiQueue: Promise.resolve(), uiAbort: new AbortController() };
  };

  pi.registerEntryRenderer("pi-cloud-live", (entry, _options, theme) => {
    const data = entry.data as { text?: unknown } | undefined;
    return typeof data?.text === "string" ? new Markdown(`${theme.fg("accent", "☁ Pi Cloud")}\n${safeDisplayText(data.text)}`, 0, 0, getMarkdownTheme()) : undefined;
  });
  const commands: Record<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>> = {};
  const register = (name: string, description: MessageKey, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>): void => {
    const wrapped = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try { await handler(args, ctx); }
      catch (error) { if (!shuttingDown) ctx.ui.notify(detail(error) === "CERTIFICATE_MISMATCH" ? tr("pair.certificateUntrusted") : tr("cloud.operationFailed", { message: detail(error) }), "error"); }
    };
    commands[name] = wrapped;
    pi.registerCommand(name, { description: tr(description), handler: wrapped });
  };

  register("cloud-pair", "cloud.pairDescription", async (args, ctx) => {
    let parts = parsePairLine(args);
    if (!parts && ctx.hasUI) {
      const pasted = await ctx.ui.input(tr("cloud.pairLinePrompt"), "/cloud-pair https://VPS_IP:9443 SHA256_FINGERPRINT ONE_TIME_CODE");
      if (pasted === undefined) return;
      parts = parsePairLine(pasted);
    }
    if (!parts && ctx.hasUI) {
      const address = (await ctx.ui.input(tr("cloud.pairUrlPrompt"), "https://VPS_IP:9443"))?.trim();
      if (!address) return;
      const fingerprint = (await ctx.ui.input(tr("cloud.pairFingerprintPrompt"), "SHA256_FINGERPRINT"))?.trim();
      if (!fingerprint) return;
      const code = (await ctx.ui.input(tr("cloud.pairCodePrompt"), "ONE_TIME_CODE"))?.trim();
      if (!code) return;
      parts = [address, fingerprint, code];
    }
    if (!parts) throw new Error(tr("cloud.pairUsage"));
    const [address, fingerprint, code] = parts;
    if (!/^[a-f0-9]{64}$/i.test(normalizeFingerprint(fingerprint))) throw new Error(tr("cloud.pairUsage"));
    const connection = new CloudConnection(address, fingerprint);
    const paired = await connection.pair(code);
    const worker = await connection.workerInfo();
    if (worker.workerId !== paired.workerId) throw new Error(tr("cloud.workerIdentityMismatch"));
    const record = { baseUrl: connection.baseUrl, workerId: paired.workerId, fingerprint: normalizeFingerprint(fingerprint), token: paired.token, pairedAt: new Date().toISOString() };
    await persistState((value) => ({ ...value, connections: [...value.connections.filter((item) => item.workerId !== record.workerId), record], activeWorkerId: record.workerId }));
    if (active?.state.workerId === record.workerId) {
      active.connection = connection;
      active.retryBlocked = false;
      await connectTask(active, ctx).catch((error: unknown) => { if (active) connectionFailed(active, ctx, error); });
    }
    ctx.ui.notify(tr("cloud.pairedReady", { workerId: record.workerId, runners: worker.capabilities.runners.join(", ") }), "info");
  });

  register("cloud-unpair", "cloud.unpairDescription", async (_args, ctx) => {
    if (active) throw new Error(tr("cloud.taskActive", { taskId: active.state.taskId }));
    const selected = connectionFor();
    if (!selected) throw new Error(tr("cloud.noWorker"));
    if (!ctx.hasUI || !(await ctx.ui.confirm(tr("cloud.unpairChoice"), tr("cloud.unpairConfirm")))) return;
    try { await selected.connection.revokeToken(); }
    catch { if (!(await ctx.ui.confirm(tr("cloud.unpairChoice"), tr("cloud.unpairOffline")))) return; }
    await persistState((value) => {
      const next = { ...value, connections: value.connections.filter((item) => item.workerId !== selected.record.workerId) };
      if (next.activeWorkerId === selected.record.workerId) {
        delete next.activeWorkerId;
        if (next.connections[0]) next.activeWorkerId = next.connections[0].workerId;
      }
      return next;
    });
    ctx.ui.notify(tr("cloud.unpaired"), "info");
  });

  register("cloud-abort", "cloud.abortDescription", async (_args, ctx) => {
    const task = active;
    if (!task) throw new Error(tr("cloud.noTask"));
    task.state.pendingAbort = true;
    await persistTask(task.state);
    if (task.socket?.readyState === 1) sendOutbox(task);
    else { task.retryBlocked = false; await connectTask(task, ctx).catch((error: unknown) => connectionFailed(task, ctx, error)); }
    ctx.ui.notify(tr(task.socket?.readyState === 1 ? "cloud.abortRequested" : "cloud.disconnectedRunning"), "info");
  });

  const submitTask = async (args: string, ctx: ExtensionCommandContext, workerId?: string): Promise<void> => {
    requireIdle(ctx);
    if (active || submitting) throw new Error(tr("cloud.taskActive", { taskId: active?.state.taskId ?? "…" }));
    if (!ctx.hasUI) throw new Error(tr("cloud.preflightTitle"));
    const selected = connectionFor(workerId);
    if (!selected) throw new Error(tr("cloud.noWorker"));
    submitting = true;
    try {
      const prompt = args.trim() || await ctx.ui.input(tr("cloud.stepTask"), tr("cloud.defaultPrompt"));
      if (!prompt) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) throw new Error(tr("cloud.persistentRequired"));
      if (!ctx.sessionManager.getSessionName()) pi.setSessionName(`☁ ${prompt.slice(0, 60)}`);
      let exists = true;
      try { await lstat(sessionFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
      if (!exists) {
        // Pi defers its first file until an assistant response. Never create that live path behind its back: open a separate native checkpoint.
        pi.appendEntry("pi-cloud-task", { checkpoint: true });
        const header = ctx.sessionManager.getHeader();
        if (!header) throw new Error(tr("cloud.persistentRequired"));
        const path = nativeSessionPath(ctx.sessionManager.getSessionDir(), header.id);
        await writePrivateFile(path, [header, ...ctx.sessionManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", true);
        const switched = await ctx.switchSession(path, { withSession: async (next) => {
          await next.sendUserMessage(`/cloud-submit ${prompt}`, { expandPromptTemplates: true });
        } });
        if (switched.cancelled) await rm(path, { force: true });
        return;
      }
      const worker = await selected.connection.workerInfo();
      if (worker.workerId !== selected.record.workerId || worker.capabilities.runtimeArchiveVersion !== 1) throw new Error(tr("cloud.upgradeWorker"));
      const runners = worker.capabilities.runners;
      const runner = runners.length === 1 ? runners[0] : await ctx.ui.select(tr("cloud.runnerChoice"), runners);
      if (runner !== "host" && runner !== "docker") return;
      if (runner === "docker" && (!worker.capabilities.dockerAvailable || worker.capabilities.dockerNetwork !== "bridge")) throw new Error(tr("cloud.networkBlocked"));
      const local = exportSessionBranch(ctx.sessionManager);
      ctx.ui.setStatus("pi-cloud", tr("cloud.scanStatus"));
      const workspace = await createWorkspaceArchive(ctx.cwd);
      const environment = await scanEnvironment({ agentDir: getAgentDir(), cwd: ctx.cwd, piVersion: VERSION, nodeVersion: process.version, platform: process.platform });
      environment.archive.manifest.secretVersions = [];
      const manifest = environment.archive.manifest;
      const credentialData = JSON.stringify(environment.credentials);
      const credentialHash = sha256(credentialData);
      const credentialId = `pi-runtime-${credentialHash}`;
      const hasCredentials = environment.credentials.files.length > 0 || Object.keys(environment.credentials.env).length > 0;
      const savedSecrets = hasCredentials ? await selected.connection.listSecrets() : [];
      const cached = savedSecrets.filter((secret) => secret.id === credentialId).sort((a, b) => b.version - a.version)[0];
      const reusable = cached && !cached.revokedAt && cached.sha256 === credentialHash;
      const taskId = randomUUID();
      const environmentData = Buffer.from(JSON.stringify(environment.archive));
      const gitData = Buffer.from(serializeWorkspaceArchive(workspace));
      const sessionData = Buffer.from(serializeSessionArchive(local));
      const payloads = [
        { choice: "environment", id: artifactId("environment", environmentData), kind: "environment" as const, data: environmentData, contentType: "application/json" },
        { choice: "git", id: artifactId("workspace", gitData), kind: "workspace" as const, data: gitData, contentType: "application/json" },
        { choice: "session", id: artifactId("session", sessionData), kind: "session" as const, data: sessionData, contentType: "application/jsonl" },
      ];
      const items: SyncPreflightItem[] = [
        { id: "environment", label: tr("cloud.environmentLabel"), description: `${tr("cloud.environmentDescription", { resources: manifest.resources.length, providers: manifest.providers.length, size: formatSize(environmentData.byteLength) })} · ${tr("cloud.reuseOnRetry")}`, selected: true },
        { id: "git", label: tr("cloud.gitLabel"), description: `${tr("cloud.gitDescription", { files: workspace.snapshot.files.length, size: formatSize(gitData.byteLength) })} · ${tr("cloud.reuseOnRetry")}`, selected: true, required: true },
        { id: "session", label: tr("cloud.sessionLabel"), description: `${tr("cloud.sessionDescription", { entries: local.entries.length, size: formatSize(sessionData.byteLength) })} · ${tr("cloud.reuseOnRetry")}`, selected: true },
      ];
      if (hasCredentials) items.push({ id: "credentials", label: tr("cloud.credentialsLabel"), description: tr(reusable ? "cloud.credentialReuse" : "cloud.credentialsDescription"), selected: false });
      ctx.ui.setStatus("pi-cloud", undefined);
      const summary = [tr("cloud.projectPath", { path: safeDisplayText(await repositoryRoot(ctx.cwd)) }),
        `${selected.record.baseUrl} · ${runner} · HEAD ${workspace.snapshot.baseline.head.slice(0, 12)}`,
        tr("cloud.projectIntro"), tr("cloud.projectTransfer")];
      let chosen: Set<string>;
      while (true) {
        const selection = await selectSyncItems(ctx, items, { title: tr("cloud.stepSync"), summary, required: tr("cloud.required"), upload: tr("cloud.preflightNext"), cancel: tr("cloud.back"), help: tr("cloud.preflightNextHelp"), empty: tr("cloud.preflightEmpty") });
        if (!selection || shuttingDown) { if (!shuttingDown) ctx.ui.notify(tr("cloud.cancelled"), "info"); return; }
        chosen = selection;
        for (const item of items) item.selected = chosen.has(item.id);
        const warnings = [
          ...(runner === "host" ? [tr("cloud.hostWarning")] : []),
          ...(chosen.has("credentials") ? [tr("cloud.credentialsDescription")] : [tr("cloud.missingCredentials")]),
          ...manifest.warnings.map((warning) => tr("task.platformWarning", { path: warning.path ?? warning.code })),
          ...(worker.capabilities.piVersion === VERSION ? [] : [`Pi ${VERSION} → ${worker.capabilities.piVersion}`]),
        ];
        if (await ctx.ui.confirm(`${tr("cloud.stepConfirm")} · ${tr(chosen.has("credentials") ? "cloud.confirmSecrets" : "cloud.compatibilityTitle")}`, [selected.record.baseUrl, `Pi ${VERSION} → ${worker.capabilities.piVersion} · ${runner}`, ...(ctx.model ? [`${ctx.model.provider}/${ctx.model.id}`] : []), prompt, ...items.filter((item) => chosen.has(item.id)).map((item) => item.label), tr("cloud.projectReturn"), ...warnings].join("\n\n"))) break;
      }
      requireIdle(ctx);
      if (shuttingDown || exportSessionBranch(ctx.sessionManager).entriesSha256 !== local.entriesSha256 || !(await currentGitMatches(ctx.cwd, workspace.snapshot.baseline))) throw new Error(tr("cloud.preflightChanged"));
      const selectedPayloads = payloads.filter((payload) => chosen.has(payload.choice));
      if (selectedPayloads.some((payload) => payload.data.length > Math.min(worker.capabilities.maxArtifactBytes, 50 * 1024 * 1024))) throw new Error("ARTIFACT_TOO_LARGE");
      const localCursor: SessionCursor = { sessionId: local.header.id, baseLeafId: local.leafId, lastEntryId: local.leafId, entriesSha256: local.entriesSha256 };
      const task: TaskSpec = {
        taskId, projectId: ctx.cwd, prompt, runner,
        ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel() } } : {}),
        environment: chosen.has("environment") ? { ...manifest, secretVersions: [] } : { ...manifest, resources: [], packages: [], providers: [], secretVersions: [] },
        git: workspace.snapshot.baseline,
        session: chosen.has("session") ? localCursor : { sessionId: randomUUID(), baseLeafId: null, lastEntryId: null, entriesSha256: sha256("") },
        artifacts: selectedPayloads.map(({ id, kind, data, contentType }) => ({ id, kind, size: data.length, sha256: sha256(data), contentType })),
        secretIds: [],
      };
      const saved: CloudTaskState = { ...localCursor, taskId, workerId: selected.record.workerId, baseUrl: selected.record.baseUrl,
        fingerprint: selected.record.fingerprint, projectId: ctx.cwd, sessionPath: sessionFile, remoteSession: task.session,
        git: task.git, spec: task, readyToSubmit: false, accepted: false, cursor: 0, status: "queued", prompt, updatedAt: new Date().toISOString() };
      const running = makeActive(saved, selected.connection, ctx);
      active = running;
      lastResult = undefined;
      await persistTask(saved);
      pi.appendEntry("pi-cloud-task", { taskId, status: "queued", prompt });
      try {
        for (const payload of selectedPayloads) {
          if (shuttingDown) return;
          const reused = await selected.connection.hasArtifact(payload.id);
          ctx.ui.setStatus("pi-cloud", `${tr(reused ? "cloud.reusing" : "cloud.uploading")} · ${payload.choice} · ${formatSize(payload.data.length)}`);
          if (!reused) await selected.connection.upload(payload.id, payload.data, payload.contentType);
        }
        if (shuttingDown) return;
        if (chosen.has("credentials")) {
          const metadata = reusable ? cached : await selected.connection.uploadSecret(credentialId, credentialData, (cached?.version ?? 0) + 1);
          if (!metadata) throw new Error("credential authorization metadata is missing");
          task.secretIds = [credentialId];
          task.environment.secretVersions = [{ id: credentialId, version: metadata.version, sha256: credentialHash, authorized: true }];
        }
        saved.readyToSubmit = true;
        await persistTask(saved);
        if (shuttingDown) return;
        ctx.ui.setStatus("pi-cloud", tr("cloud.connecting"));
        await connectTask(running, ctx, true);
      } catch (error) {
        if (shuttingDown) return;
        if (saved.readyToSubmit) connectionFailed(running, ctx, error);
        else finishTask(running, { taskId, status: "failed", cursor: saved.cursor, result: { taskId, status: "failed", error: detail(error) } }, ctx);
        throw error;
      }
    } finally {
      submitting = false;
      if (!shuttingDown && !active) ctx.ui.setStatus("pi-cloud", undefined);
    }
  };
  register("cloud-submit", "cloud.submitDescription", submitTask);

  register("cloud-retry", "cloud.retryDescription", async (_args, ctx) => {
    requireIdle(ctx);
    if (active || submitting) throw new Error(tr("cloud.taskActive", { taskId: active?.state.taskId ?? "…" }));
    const failed = lastResult;
    if (!failed || !isTerminal(failed) || failed.status !== "failed") throw new Error(tr("cloud.noRetryableTask"));
    const selected = connectionFor(failed.workerId);
    if (!selected) throw new Error(tr("cloud.noWorker"));
    ctx.ui.notify(tr("cloud.retryStarting", { taskId: failed.taskId }), "info");
    await submitTask(failed.prompt, ctx, selected.record.workerId);
  });

  register("cloud-reconnect", "cloud.reconnectDescription", async (_args, ctx) => {
    if (!active) throw new Error(tr("cloud.noTask"));
    const task = active;
    task.retryBlocked = false;
    try { await connectTask(task, ctx); }
    catch (error) { connectionFailed(task, ctx, error); throw error; }
  });

  register("cloud-apply", "cloud.applyDescription", async (args, ctx) => {
    requireIdle(ctx);
    if (active) throw new Error(tr("cloud.taskActive", { taskId: active.state.taskId }));
    const task = resultTask(ctx, "artifactId", args);
    const selected = task && connectionFor(task.workerId);
    if (!task?.artifactId || !selected) throw new Error(tr("cloud.resultMissing"));
    if (!task.git) throw new Error(tr("cloud.gitBaseMissing"));
    const raw = await selected.connection.download(task.artifactId);
    const snapshot = parseGitSnapshot(raw.toString("utf8"));
    const root = await repositoryRoot(ctx.cwd);
    const paths = (await Promise.all(snapshot.files.map((file) => safeFilePath(root, file.path)))).sort();
    const reviewAndApply = async (): Promise<void> => {
      if (!(await currentGitMatches(ctx.cwd, task.git!))) throw new Error(tr("result.baseMismatch"));
      const patches: string[] = [];
      for (const file of snapshot.files) {
        const before = await readFile(await safeFilePath(root, file.path)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; });
        const after = file.status === "deleted" ? Buffer.alloc(0) : Buffer.from(file.contentBase64 ?? "", "base64");
        patches.push(`${file.status} ${file.path} (${file.mode ?? "100644"})\n${before.includes(0) || after.includes(0)
          ? `binary: ${before.length} → ${after.length} bytes; sha256 ${sha256(after)}\n`
          : generateUnifiedPatch(file.path, before.toString("utf8"), after.toString("utf8"))}`);
      }
      validateIdentifier(task.taskId);
      const reviewPath = join(getAgentDir(), "cloud", task.taskId, "review.patch");
      await writePrivateFile(reviewPath, patches.join("\n"));
      await writePrivateFile(join(getAgentDir(), "cloud", task.taskId, "result.json"), raw);
      ctx.ui.notify(tr("cloud.reviewSaved", { path: reviewPath }), "info");
      if (!snapshot.files.length) {
        if (task.git) task.appliedGit = task.git;
        await persistTask(task);
        ctx.ui.notify(tr("cloud.noChanges"), "info");
        return;
      }
      const preview = truncateHead(safeDisplayText(patches.join("\n")), { maxLines: 100, maxBytes: 10_000 }).content;
      if (!ctx.hasUI || !(await ctx.ui.confirm(tr("cloud.applyConfirm"), `${preview}\n\n${tr("cloud.reviewSaved", { path: reviewPath })}`))) return;
      requireIdle(ctx);
      const changed = await applyGitSnapshot(ctx.cwd, snapshot, task.git!);
      task.appliedGit = (await createGitSnapshot(ctx.cwd)).baseline;
      await persistTask(task);
      ctx.ui.notify(tr("cloud.applied", { count: changed.length }), "info");
    };
    // Native file locks span the complete review/read/modify/write window, in deterministic order.
    const locked = (index = 0): Promise<void> => index === paths.length ? reviewAndApply() : withFileMutationQueue(paths[index]!, () => locked(index + 1));
    await locked();
  });

  register("cloud-merge", "cloud.mergeDescription", async (args, ctx) => {
    requireIdle(ctx);
    if (active) throw new Error(tr("cloud.taskActive", { taskId: active.state.taskId }));
    const task = resultTask(ctx, "sessionArtifactId", args);
    const selected = task && connectionFor(task.workerId);
    if (!task?.sessionArtifactId || !selected) throw new Error(tr("cloud.sessionResultMissing"));
    if (task.mergedSessionId) { ctx.ui.notify(tr("cloud.alreadyMerged"), "info"); return; }
    if (task.sessionId !== ctx.sessionManager.getSessionId()) throw new Error(tr("cloud.sessionMismatch"));
    if (!task.git) throw new Error(tr("cloud.gitBaseMissing"));
    if (!(await currentGitMatches(ctx.cwd, task.appliedGit ?? task.git))) throw new Error(tr("result.baseMismatch"));
    const source = exportSessionBranch(ctx.sessionManager);
    const raw = await selected.connection.download(task.sessionArtifactId);
    let remote = parseSessionArchive(raw.toString("utf8"));
    if (task.remoteSession && task.remoteSession.sessionId !== task.sessionId) {
      const empty = { header: { ...remote.header }, entries: [], leafId: null, entriesSha256: sha256("") };
      const tail = mergeSessionTail(empty, remote, task.remoteSession);
      const entries = [...source.entries, ...tail.entries.map((entry, index) => index === 0 ? { ...entry, parentId: source.leafId } : entry)];
      remote = parseSessionArchive([JSON.stringify(source.header), ...entries.map((entry) => JSON.stringify(entry))].join("\n"));
    }
    const merged = mergeSessionTail(source, remote, { sessionId: task.sessionId, baseLeafId: task.baseLeafId, lastEntryId: task.lastEntryId, entriesSha256: task.entriesSha256 });
    const parentSession = ctx.sessionManager.getSessionFile();
    if (parentSession) merged.header.parentSession = parentSession;
    merged.header.cwd = ctx.cwd;
    if (!ctx.hasUI || !(await ctx.ui.confirm(tr("cloud.mergeChoice"), tr("cloud.mergeConfirm")))) return;
    requireIdle(ctx);
    if (exportSessionBranch(ctx.sessionManager).entriesSha256 !== source.entriesSha256 || !(await currentGitMatches(ctx.cwd, task.appliedGit ?? task.git))) throw new Error(tr("cloud.preflightChanged"));
    validateIdentifier(task.taskId);
    await writePrivateFile(join(getAgentDir(), "cloud", task.taskId, "remote-session.jsonl"), raw);
    const path = nativeSessionPath(ctx.sessionManager.getSessionDir(), merged.header.id);
    await writeMergedSession(path, merged);
    task.mergedSessionId = merged.header.id;
    await persistTask(task);
    const switched = await ctx.switchSession(path, { withSession: async (next) => { next.ui.notify(tr("cloud.merged"), "info"); } });
    if (switched.cancelled) { delete task.mergedSessionId; await persistTask(task); }
  });

  register("cloud-local", "cloud.localDescription", async (_args, ctx) => {
    requireIdle(ctx);
    if (!ctx.hasUI || !(await ctx.ui.confirm(tr("cloud.localChoice"), tr("cloud.localWarning")))) return;
    pi.appendEntry("pi-cloud-task", { localBranch: true });
    const leaf = ctx.sessionManager.getLeafId();
    if (!leaf) throw new Error(tr("cloud.sessionMissing"));
    await ctx.fork(leaf, { position: "at", withSession: async (next) => { next.ui.notify(tr("cloud.localStarted"), "info"); } });
  });

  register("cloud-tasks", "cloud.historyDescription", async (_args, ctx) => {
    const tasks = tasksFor(ctx).slice().reverse();
    if (!tasks.length) { ctx.ui.notify(tr("cloud.noTask"), "info"); return; }
    const items = tasks.map((task) => ({ value: task.taskId, label: `${statusText(task)} · ${safeDisplayText(task.prompt).slice(0, 60)}`, description: task.updatedAt }));
    const selected = await selectCloudMenu(ctx, tr("cloud.historyChoice"), [], items, tr("cloud.menuHelp"));
    const task = tasks.find((item) => item.taskId === selected);
    if (!task) return;
    if (task.sessionId === ctx.sessionManager.getSessionId()) {
      lastResult = task;
      if (active) disconnect(active);
      active = undefined;
      if (isTerminal(task)) showResult(task, ctx);
      else {
        const connection = connectionFor(task.workerId);
        if (!connection) throw new Error(tr("cloud.noWorker"));
        active = makeActive(task, connection.connection, ctx);
        await connectTask(active, ctx);
      }
      return;
    }
    if (!task.sessionPath) throw new Error(tr("cloud.sessionMissing"));
    const original = parseSessionArchive(await readFile(task.sessionPath, "utf8"));
    if (original.header.id !== task.sessionId || !sameProject(original.header.cwd, ctx.cwd)) throw new Error(tr("cloud.sessionMissing"));
    if (await ctx.ui.confirm(tr("cloud.returnSession"), task.prompt)) await ctx.switchSession(task.sessionPath);
  });

  register("cloud-inputs", "cloud.unsentDescription", async (_args, ctx) => {
    const task = active?.state ?? lastResult;
    const inputs = task?.pendingInputs ?? [];
    if (!inputs.length) { ctx.ui.notify(tr("cloud.noPendingInput"), "info"); return; }
    const text = inputs.map((input, index) => `${index + 1}. [${input.delivery}] ${input.message}${input.images?.length ? `\n[${input.images.length} images retained locally]` : ""}`).join("\n\n");
    if (ctx.hasUI) await ctx.ui.editor(tr("cloud.unsentDescription"), safeDisplayText(text));
    else ctx.ui.notify(safeDisplayText(text), "warning");
  });

  register("cloud-secrets", "cloud.credentialDescription", async (_args, ctx) => {
    const selected = connectionFor(active?.state.workerId);
    if (!selected) throw new Error(tr("cloud.noWorker"));
    const secrets = (await selected.connection.listSecrets()).filter((secret) => !secret.revokedAt);
    if (!secrets.length) { ctx.ui.notify(tr("cloud.noCredentials"), "info"); return; }
    const choice = await selectCloudMenu(ctx, tr("cloud.credentialChoice"), [], secrets.map((secret) => ({ value: secret.id,
      label: `${secret.id.slice(0, 28)} · v${secret.version}`, description: secret.createdAt })), tr("cloud.menuHelp"));
    if (!choice || !(await ctx.ui.confirm(tr("cloud.credentialChoice"), tr("cloud.credentialRevoke")))) return;
    await selected.connection.revokeSecret(choice);
    ctx.ui.notify(tr("cloud.credentialRevoked"), "info");
  });

  register("cloud-worker", "cloud.workerDescription", async (_args, ctx) => {
    const choice = await selectCloudMenu(ctx, tr("cloud.workerChoice"), [], state.connections.map((item) => ({ value: item.workerId, label: item.baseUrl, description: item.workerId })), tr("cloud.menuHelp"));
    if (choice) await persistState((value) => ({ ...value, activeWorkerId: choice }));
  });
  register("cloud-status", "cloud.statusDescription", async (_args, ctx) => {
    const task = active?.state ?? lastResult;
    const selected = connectionFor(task?.workerId);
    if (!selected) { ctx.ui.notify(tr("cloud.noWorker"), "warning"); return; }
    const worker = await selected.connection.workerInfo();
    const lines = [tr("cloud.connected", { address: selected.record.baseUrl, workerId: worker.workerId }),
      `Pi ${worker.capabilities.piVersion} · ${worker.capabilities.runners.join(", ")} · Docker network: ${worker.capabilities.dockerNetwork ?? "none"}`,
      task ? statusText(task) : tr("cloud.idleStatus")];
    ctx.ui.setWidget("pi-cloud", lines);
    ctx.ui.notify(lines[0]!, "info");
  });
  register("cloud-help", "cloud.helpDescription", async (_args, ctx) => {
    ctx.ui.setWidget("pi-cloud-help", tr("cloud.helpText").split("\n"));
    ctx.ui.notify(tr("cloud.helpChoice"), "info");
  });
  register("cloud-language", "cloud.languageDescription", async (args, ctx) => {
    const choice = args.trim() || (ctx.hasUI ? await ctx.ui.select(tr("cloud.languageChoice"), ["简体中文", "English"]) : undefined);
    if (!choice) return;
    if (!["简体中文", "English", "zh-CN", "en"].includes(choice)) throw new Error("Use zh-CN or en");
    locale = choice === "简体中文" || choice === "zh-CN" ? "zh-CN" : "en";
    await persistState((value) => ({ ...value, locale }));
    await ctx.reload();
  });
  register("cloud-sponsor", "recommendation.sponsorPlaceholder", async (_args, ctx) => { ctx.ui.notify(tr("recommendation.sponsorPlaceholder"), "info"); });

  register("cloud", "cloud.menu", async (args, ctx) => {
    const text = args.trim();
    const [name = ""] = text.split(/\s+/);
    const alias: Record<string, string> = { run: "submit", sync: "merge", language: "language", config: "worker" };
    if (name) {
      const handler = commands[`cloud-${alias[name] ?? name}`];
      if (handler && name !== "cloud") await handler(text.slice(name.length).trim(), ctx);
      else ctx.ui.notify(tr("cloud.helpText"), "info");
      return;
    }
    if (!ctx.hasUI) { ctx.ui.notify(tr("cloud.helpText"), "info"); return; }
    if (wizardOpen) return;
    wizardOpen = true;
    try {
      while (!shuttingDown) {
        const selected = connectionFor(active?.state.workerId);
        const task = active?.state ?? lastResult;
        const firstProject = !tasksFor(ctx).some((saved) => saved.workerId === selected?.record.workerId && saved.accepted);
        const status = [tr("cloud.projectPath", { path: safeDisplayText(ctx.cwd) })];
        const items: CloudMenuItem[] = [];
        const item = (command: string, label: MessageKey, description: MessageKey = label) => items.push({ value: command, label: tr(label), description: tr(description) });
        if (!selected) {
          status.push(tr("cloud.welcomeBody"));
          item("cloud-pair", "cloud.installedChoice", "cloud.pairDescription");
          item("install", "cloud.installChoice", "cloud.installDescription");
        } else {
          status.push(selected.record.baseUrl);
          if (task) status.push(statusText(task));
          if (active) {
            status.push(...safeDisplayText(active.preview).split("\n").slice(-3), tr("cloud.liveHelp"));
            item("watch", "cloud.watchChoice");
            item("cloud-reconnect", "cloud.reconnectChoice", "cloud.reconnectDescription");
            item("cloud-abort", "cloud.abortChoice", "cloud.abortDescription");
          } else {
            if (task?.error) status.push(safeDisplayText(task.error));
            if (task?.artifactId || task?.sessionArtifactId) {
              status.push(tr("cloud.reviewNext"));
              if (task.appliedGit) status.push(tr("cloud.filesReceived"));
              else if (task.artifactId) item("cloud-apply", "cloud.applyChoice", "cloud.applyDescription");
              if (task.mergedSessionId) status.push(tr("cloud.conversationReceived"));
              else if (task.sessionArtifactId) item("cloud-merge", "cloud.mergeChoice", "cloud.mergeDescription");
            } else status.push(tr("cloud.projectIntro"), tr("cloud.projectReturn"));
            if (task?.status === "failed") item("cloud-retry", "cloud.retryChoice", "cloud.retryDescription");
            item("cloud-submit", firstProject ? "cloud.firstProject" : "cloud.submitChoice", "cloud.submitDescription");
          }
        }
        item("more", "cloud.more", "cloud.moreDescription");
        let choice = await selectCloudMenu(ctx, tr(selected ? "cloud.menu" : "cloud.welcomeTitle"), status, items, tr("cloud.menuHelp"));
        if (!choice || choice === "watch" || shuttingDown) return;
        if (choice === "install") {
          choice = await selectCloudMenu(ctx, tr("cloud.installTitle"), [tr("cloud.installBody"),
            `curl -fsSL https://raw.githubusercontent.com/WSXYT/pi-cloud-computing/main/scripts/install.sh | bash -s -- --worker --lang ${locale}`], [
            { value: "cloud-pair", label: tr("cloud.installedChoice"), description: tr("cloud.pairDescription") },
            { value: "back", label: tr("cloud.back") },
          ], tr("cloud.menuHelp"));
          if (!choice || choice === "back") continue;
        } else if (choice === "more") {
          const more: CloudMenuItem[] = [];
          const add = (command: string, label: MessageKey, description: MessageKey = label) => more.push({ value: command, label: tr(label), description: tr(description) });
          if (active || lastResult) add("cloud-local", "cloud.localChoice", "cloud.localDescription");
          if (task?.pendingInputs?.length) add("cloud-inputs", "cloud.unsentDescription");
          if (selected) {
            add("cloud-status", "cloud.statusChoice", "cloud.statusDescription");
            add("cloud-secrets", "cloud.credentialChoice", "cloud.credentialDescription");
            if (!active) add("cloud-unpair", "cloud.unpairChoice", "cloud.unpairDescription");
            add("cloud-pair", "cloud.pairOther", "cloud.pairDescription");
          }
          if (state.connections.length > 1) add("cloud-worker", "cloud.workerChoice", "cloud.workerDescription");
          if (tasksFor(ctx).length) add("cloud-tasks", "cloud.historyChoice", "cloud.historyDescription");
          add("cloud-help", "cloud.helpChoice", "cloud.helpDescription");
          add("cloud-language", "cloud.languageChoice", "cloud.languageDescription");
          add("back", "cloud.back");
          choice = await selectCloudMenu(ctx, tr("cloud.more"), [], more, tr("cloud.menuHelp"));
          if (!choice || choice === "back") continue;
        }
        // A remote task may finish while the menu is open; don't apply an action to a different task.
        if (["cloud-apply", "cloud-merge", "cloud-retry", "cloud-abort", "cloud-reconnect"].includes(choice)
          && task?.taskId !== (active?.state ?? lastResult)?.taskId) continue;
        if (choice === "cloud-submit" || choice === "cloud-retry") {
          try { await assertGitRepository(ctx.cwd); }
          catch (error) { ctx.ui.notify(tr("cloud.gitRequired", { message: detail(error) }), "warning"); continue; }
        }
        if (choice === "cloud-abort" && !(await ctx.ui.confirm(tr("cloud.abortChoice"), tr("cloud.abortConfirm")))) continue;
        await commands[choice]?.("", ctx);
        // Session switches destroy this context. Task execution returns focus for steering and remote dialogs.
        if (shuttingDown || (active && ["cloud-submit", "cloud-retry", "cloud-reconnect", "cloud-abort"].includes(choice))) return;
      }
    } finally { wizardOpen = false; }
  });

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    if (active) disconnect(active);
    active = undefined;
    lastResult = undefined;
    state = await loadClientState();
    const sessionId = ctx.sessionManager.getSessionId();
    const task = tasksFor(ctx).findLast((item) => item.sessionId === sessionId || item.mergedSessionId === sessionId);
    if (!task) return;
    if (isTerminal(task)) { lastResult = task; showResult(task, ctx); return; }
    const selected = connectionFor(task.workerId);
    if (!selected) { ctx.ui.notify(tr("cloud.noWorker"), "warning"); return; }
    const running = makeActive(task, selected.connection, ctx);
    active = running;
    try { await connectTask(running, ctx); ctx.ui.notify(tr("cloud.restored", { taskId: task.taskId }), "info"); }
    catch (error) { connectionFailed(running, ctx, error); }
  });
  pi.on("input", async (event, ctx) => {
    const task = active;
    if (!task) {
      if (lastResult?.status === "completed" && lastResult.sessionArtifactId && !lastResult.mergedSessionId) {
        ctx.ui.setEditorText(event.text);
        ctx.ui.notify(tr("cloud.mergeBeforeContinue"), "warning");
        return { action: "handled" };
      }
      return { action: "continue" };
    }
    try {
      const input = parseTaskInput({ taskId: task.state.taskId, id: randomUUID(), delivery: event.streamingBehavior ?? "followUp", message: event.text, ...(event.images?.length ? { images: event.images } : {}) });
      task.state.pendingInputs = [...(task.state.pendingInputs ?? []), input];
      await persistTask(task.state);
      if (shuttingDown || active !== task) return { action: "handled" };
      sendOutbox(task);
      if (!task.socket) scheduleReconnect(task, ctx);
      showTask(task, ctx);
    } catch (error) {
      ctx.ui.setEditorText(event.text);
      ctx.ui.notify(tr("cloud.inputInvalid", { message: detail(error) }), "error");
    }
    return { action: "handled" };
  });
  pi.on("session_before_compact", async (_event, ctx) => {
    if (active) { ctx.ui.notify(tr("cloud.localWarning"), "warning"); return { cancel: true }; }
    return undefined;
  });
  pi.on("session_before_tree", async (_event, ctx) => {
    if (active) { ctx.ui.notify(tr("cloud.localWarning"), "warning"); return { cancel: true }; }
    return undefined;
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (active) disconnect(active);
    active = undefined;
    await persistence;
  });
}
