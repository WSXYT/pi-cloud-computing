import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  parseTaskUiRequest,
  type TaskInput,
  type TaskUiResponse,
} from "../protocol.js";
import type { ExecutionRunner } from "./runner.js";
import type { TaskRecord, WorkerTaskManager } from "./tasks.js";

export interface PiRpcExecutorOptions {
  command?: string;
  baseArgs?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runner?: ExecutionRunner;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  closing: boolean;
  done: Promise<void>;
}

export class PiRpcExecutor {
  private readonly processes = new Map<string, RunningProcess>();
  private readonly unsubscribe: () => void;
  private disposing = false;

  constructor(
    private readonly tasks: WorkerTaskManager,
    private readonly options: PiRpcExecutorOptions,
  ) {
    this.unsubscribe = tasks.subscribe((event) => {
      if (event.kind !== "message") return;
      const input = tasks.get(event.taskId)?.inputs.at(-1);
      if (input) this.sendInput(event.taskId, input);
    });
  }

  start(
    record: TaskRecord,
    sessionPath?: string,
    cwd = this.options.cwd,
    onComplete?: (succeeded: boolean) => Promise<Record<string, unknown>>,
    envOverrides: NodeJS.ProcessEnv = {},
  ): void {
    const taskId = record.task.taskId;
    if (record.status !== "running") throw new Error("task is not active");
    if (this.processes.has(taskId))
      throw new Error("task process already started");
    const args = [
      ...(this.options.baseArgs ?? [
        "--mode",
        "rpc",
        record.task.artifacts.some((item) => item.kind === "environment")
          ? "--approve"
          : "--no-approve",
      ]),
      ...(sessionPath ? ["--session", sessionPath] : ["--no-session"]),
      ...(record.task.model
        ? [
            "--provider",
            record.task.model.provider,
            "--model",
            record.task.model.id,
            ...(record.task.model.thinkingLevel
              ? ["--thinking", record.task.model.thinkingLevel]
              : []),
          ]
        : []),
    ];
    // Do not inherit the Worker's provider credentials, NODE_OPTIONS, or Pi profile.
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "TMP",
      "TEMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, this.options.env, envOverrides, {
      GIT_TERMINAL_PROMPT: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
    if (!this.options.command && envOverrides.PI_CLOUD_BOOTSTRAP)
      args.unshift(envOverrides.PI_CLOUD_BOOTSTRAP);
    const command =
      this.options.command ?? (envOverrides.PI_CLOUD_BOOTSTRAP ? "node" : "pi");
    const child = (this.options.runner ?? { spawn }).spawn(command, args, {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
    });
    const completion = Promise.withResolvers<void>();
    const running: RunningProcess = {
      child,
      closing: false,
      done: completion.promise,
    };
    this.processes.set(taskId, running);
    let settled = false;
    let fatalError: string | undefined;
    let assistantError: string | undefined;
    let terminatedAfterSettlement = false;
    let shutdownTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (running.closing) return;
      running.closing = true;
      child.stdin.end();
      shutdownTimer = setTimeout(() => {
        terminatedAfterSettlement = settled;
        this.terminate(child, "SIGTERM");
        killTimer = setTimeout(() => this.terminate(child, "SIGKILL"), 2_000);
        killTimer.unref();
      }, this.options.shutdownTimeoutMs ?? 5_000);
      shutdownTimer.unref();
    };
    const fail = (message: string) => {
      fatalError ??= message;
      stop();
    };
    const startup = setTimeout(
      () => fail("Pi did not accept the prompt before the startup timeout"),
      this.options.startupTimeoutMs ?? 300_000,
    );
    startup.unref();
    child.stdin.on("error", (error: Error) => {
      if (!running.closing) fail(error.message);
    });
    this.readEvents(
      taskId,
      child,
      (rpc) => {
        if (rpc.type === "agent_start" || rpc.type === "response")
          clearTimeout(startup);
        if (
          rpc.type === "response" &&
          rpc.success === false &&
          (rpc.id === "pi-cloud-initial" ||
            rpc.id === undefined ||
            rpc.command === "parse")
        )
          fail(
            typeof rpc.error === "string"
              ? rpc.error
              : "Pi rejected the prompt",
          );
        if (
          rpc.type === "message_end" &&
          rpc.message &&
          typeof rpc.message === "object"
        ) {
          const message = rpc.message as Record<string, unknown>;
          if (message.role === "assistant") {
            assistantError =
              message.stopReason === "error" || message.stopReason === "aborted"
                ? typeof message.errorMessage === "string"
                  ? message.errorMessage
                  : `Pi assistant ${String(message.stopReason)}`
                : undefined;
          }
        }
        if (rpc.type === "auto_retry_end" && rpc.success === false)
          assistantError =
            typeof rpc.finalError === "string"
              ? rpc.finalError
              : "Pi retries exhausted";
        if (
          rpc.type === "extension_ui_request" &&
          ["select", "confirm", "input", "editor"].includes(String(rpc.method))
        ) {
          try {
            this.tasks.requestUi(taskId, parseTaskUiRequest(rpc));
          } catch {
            fail("Pi emitted an invalid remote dialog request");
          }
        }
        if (rpc.type === "agent_settled") {
          settled = true;
          clearTimeout(startup);
          stop();
        }
      },
      fail,
    );
    child.once("error", (error) => fail(error.message));
    child.once("close", (code, signal) => {
      clearTimeout(startup);
      clearTimeout(shutdownTimer);
      clearTimeout(killTimer);
      running.closing = true;
      const error =
        fatalError ??
        assistantError ??
        (settled
          ? undefined
          : this.disposing
            ? "Worker stopped before the Pi run settled"
            : "Pi exited before its run settled");
      const succeeded =
        !error &&
        settled &&
        (code === 0 || (code === null && terminatedAfterSettlement));
      void (async () => {
        try {
          // Disposal/result collection is mandatory even after abort or spawn failure.
          const payload = onComplete
            ? await onComplete(succeeded && record.status !== "aborted")
            : {};
          if (record.status === "aborted") {
            this.tasks.complete({
              ...record.result!,
              ...payload,
              taskId,
              status: "aborted",
            });
          } else {
            this.tasks.settle(taskId, succeeded ? "completed" : "failed", {
              ...payload,
              exitCode: code,
              signal,
              ...(succeeded
                ? {}
                : {
                    error: error ?? `Pi exited with code ${String(code)}`,
                    retryable: this.disposing,
                  }),
            });
          }
        } catch (cause) {
          if (record.status === "aborted") {
            this.tasks.complete({
              ...record.result!,
              taskId,
              status: "aborted",
              error: String(cause),
            });
          } else
            this.tasks.settle(taskId, "failed", {
              error: cause instanceof Error ? cause.message : String(cause),
            });
        } finally {
          this.processes.delete(taskId);
          completion.resolve();
        }
      })();
    });
    this.write(child, {
      id: "pi-cloud-initial",
      type: "prompt",
      message: record.task.prompt,
    });
    // Inputs received while the repository/environment was being prepared are durable.
    for (const input of record.inputs) this.sendInput(taskId, input);
  }

  acceptsInput(taskId: string): boolean {
    return !this.processes.get(taskId)?.closing;
  }

  abort(taskId: string): void {
    const running = this.processes.get(taskId);
    if (
      !running ||
      running.child.exitCode !== null ||
      running.child.signalCode !== null
    )
      return;
    running.closing = true;
    this.write(running.child, { type: "clear_queue" });
    this.write(running.child, { type: "abort" });
    this.terminate(running.child, "SIGTERM");
    const timer = setTimeout(
      () => this.terminate(running.child, "SIGKILL"),
      2_000,
    );
    timer.unref();
    running.child.once("close", () => clearTimeout(timer));
  }

  sendInput(taskId: string, input: TaskInput): boolean {
    const running = this.processes.get(taskId);
    if (!running || running.closing) return false;
    this.write(running.child, {
      type: "prompt",
      ...(input.id ? { id: input.id } : {}),
      message: input.message,
      ...(input.images ? { images: input.images } : {}),
      streamingBehavior:
        input.delivery === "prompt" ? "followUp" : input.delivery,
    });
    return true;
  }

  answerUi(response: TaskUiResponse): boolean {
    const { taskId, ...answer } = response;
    const running = this.processes.get(taskId);
    if (!running || running.closing) return false;
    this.write(running.child, { type: "extension_ui_response", ...answer });
    return true;
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.unsubscribe();
    const running = [...this.processes.entries()];
    for (const [taskId] of running) this.abort(taskId);
    await Promise.all(running.map(([, process]) => process.done));
  }

  private terminate(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    if (this.options.runner?.terminate)
      this.options.runner.terminate(child, signal);
    else child.kill(signal);
  }

  private write(
    child: ChildProcessWithoutNullStreams,
    frame: Record<string, unknown>,
  ): void {
    if (!child.stdin.destroyed && !child.stdin.writableEnded)
      child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private readEvents(
    taskId: string,
    child: ChildProcessWithoutNullStreams,
    onEvent: (rpc: Record<string, unknown>) => void,
    onError: (message: string) => void,
  ): void {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const forward = (line: string) => {
      if (!line) return;
      let rpc: unknown;
      try {
        rpc = JSON.parse(line);
      } catch {
        /* Packages may print non-RPC startup output. */
      }
      if (
        rpc &&
        typeof rpc === "object" &&
        !Array.isArray(rpc) &&
        "type" in rpc
      ) {
        this.tasks.log(taskId, { rpc });
        onEvent(rpc as Record<string, unknown>);
      } else
        this.tasks.log(taskId, {
          stream: "stdout",
          text: line.slice(0, 50_000),
        });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      if (pending.length > 50 * 1024 * 1024) {
        pending = "";
        onError("Pi RPC frame exceeded the size limit");
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        forward(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stdout.once("end", () =>
      forward((pending + decoder.end()).replace(/\r$/, "")),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      this.tasks.log(taskId, {
        stream: "stderr",
        text: chunk.toString("utf8").slice(0, 50_000),
      }),
    );
  }
}
