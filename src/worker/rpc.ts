import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { TaskInput } from "../protocol.js";
import type { ExecutionRunner } from "./runner.js";
import type { TaskRecord } from "./tasks.js";
import type { WorkerTaskManager } from "./tasks.js";

export interface PiRpcExecutorOptions {
  command?: string;
  baseArgs?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runner?: ExecutionRunner;
}

export class PiRpcExecutor {
  private readonly processes = new Map<
    string,
    ChildProcessWithoutNullStreams
  >();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tasks: WorkerTaskManager,
    private readonly options: PiRpcExecutorOptions,
  ) {
    this.unsubscribe = tasks.subscribe((event) => {
      if (event.kind !== "message") return;
      const payload = event.payload;
      const delivery = payload.delivery;
      if (
        delivery !== "prompt" &&
        delivery !== "steer" &&
        delivery !== "followUp"
      )
        return;
      const message = payload.message;
      if (typeof message !== "string") return;
      this.sendInput(event.taskId, { taskId: event.taskId, delivery, message });
    });
  }

  start(
    record: TaskRecord,
    sessionPath?: string,
    cwd = this.options.cwd,
    onComplete?: (succeeded: boolean) => Promise<Record<string, unknown>>,
    envOverrides: NodeJS.ProcessEnv = {},
  ): void {
    if (record.status !== "running") throw new Error("task is not active");
    if (this.processes.has(record.task.taskId))
      throw new Error("task process already started");
    const args = [
      ...(this.options.baseArgs ?? ["--mode", "rpc"]),
      ...(sessionPath ? ["--session", sessionPath] : ["--no-session"]),
    ];
    const child = (this.options.runner ?? { spawn }).spawn(
      this.options.command ?? "pi",
      args,
      {
        cwd,
        env: { ...process.env, ...this.options.env, ...envOverrides },
        stdio: "pipe",
        windowsHide: true,
      },
    );
    this.processes.set(record.task.taskId, child);
    let agentSettled = false;
    this.readEvents(record.task.taskId, child, () => {
      agentSettled = true;
      child.stdin.end();
      setTimeout(() => child.kill(), 5000).unref();
    });
    let spawnFailed = false;
    child.once("error", (error) => {
      spawnFailed = true;
      void (onComplete ? onComplete(false) : Promise.resolve())
        .catch(() => undefined)
        .finally(() =>
          this.tasks.settle(record.task.taskId, "failed", {
            error: error.message,
          }),
        );
    });
    child.once("close", async (code, signal) => {
      this.processes.delete(record.task.taskId);
      if (record.status === "aborted" || spawnFailed) return;
      try {
        const succeeded = code === 0 || agentSettled;
        const payload = onComplete ? await onComplete(succeeded) : {};
        this.tasks.settle(
          record.task.taskId,
          succeeded ? "completed" : "failed",
          { exitCode: code, signal, ...payload },
        );
      } catch (error) {
        this.tasks.settle(record.task.taskId, "failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.write(child, { type: "prompt", message: record.task.prompt });
  }

  abort(taskId: string): void {
    const child = this.processes.get(taskId);
    if (!child) return;
    this.write(child, { type: "abort" });
    child.kill();
  }

  sendInput(taskId: string, input: TaskInput): void {
    const child = this.processes.get(taskId);
    if (!child) return;
    this.write(child, {
      type: "prompt",
      message: input.message,
      streamingBehavior:
        input.delivery === "prompt" ? undefined : input.delivery,
    });
  }

  dispose(): void {
    this.unsubscribe();
    for (const child of this.processes.values()) child.kill();
    this.processes.clear();
  }

  private write(
    child: ChildProcessWithoutNullStreams,
    frame: Record<string, unknown>,
  ): void {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private readEvents(
    taskId: string,
    child: ChildProcessWithoutNullStreams,
    onSettled: () => void,
  ): void {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line && this.forwardEvent(taskId, line)) onSettled();
        newline = pending.indexOf("\n");
      }
    });
    child.stdout.once("end", () => {
      pending += decoder.end();
      if (pending.trim() && this.forwardEvent(taskId, pending.trim()))
        onSettled();
    });
    child.stderr.on("data", (chunk: Buffer) =>
      this.tasks.log(taskId, {
        stream: "stderr",
        text: chunk.toString("utf8"),
      }),
    );
  }

  private forwardEvent(taskId: string, line: string): boolean {
    try {
      const rpc = JSON.parse(line) as { type?: unknown };
      this.tasks.log(taskId, { rpc });
      return rpc.type === "agent_settled";
    } catch {
      this.tasks.log(taskId, { stream: "stdout", text: line });
      return false;
    }
  }
}
