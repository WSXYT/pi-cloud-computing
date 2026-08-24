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

  start(record: TaskRecord, sessionPath: string): void {
    if (record.status !== "running") throw new Error("task is not active");
    if (this.processes.has(record.task.taskId))
      throw new Error("task process already started");
    const args = [
      ...(this.options.baseArgs ?? ["--mode", "rpc"]),
      "--session",
      sessionPath,
    ];
    const child = (this.options.runner ?? { spawn }).spawn(
      this.options.command ?? "pi",
      args,
      {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: "pipe",
        windowsHide: true,
      },
    );
    this.processes.set(record.task.taskId, child);
    this.readEvents(record.task.taskId, child);
    child.once("error", (error) =>
      this.tasks.settle(record.task.taskId, "failed", { error: error.message }),
    );
    child.once("close", (code, signal) => {
      this.processes.delete(record.task.taskId);
      if (record.status === "aborted") return;
      this.tasks.settle(
        record.task.taskId,
        code === 0 ? "completed" : "failed",
        { exitCode: code, signal },
      );
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
  ): void {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line) this.forwardEvent(taskId, line);
        newline = pending.indexOf("\n");
      }
    });
    child.stdout.once("end", () => {
      pending += decoder.end();
      if (pending.trim()) this.forwardEvent(taskId, pending.trim());
    });
    child.stderr.on("data", (chunk: Buffer) =>
      this.tasks.log(taskId, {
        stream: "stderr",
        text: chunk.toString("utf8"),
      }),
    );
  }

  private forwardEvent(taskId: string, line: string): void {
    try {
      this.tasks.log(taskId, { rpc: JSON.parse(line) as unknown });
    } catch {
      this.tasks.log(taskId, { stream: "stdout", text: line });
    }
  }
}
