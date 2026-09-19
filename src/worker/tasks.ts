import type {
  TaskEvent,
  TaskInput,
  TaskResult,
  TaskSnapshot,
  TaskSpec,
  TaskStatus,
  TaskUiRequest,
  TaskUiResponse,
} from "../protocol.js";

export interface TaskRecord {
  task: TaskSpec;
  status: TaskStatus;
  cursor: number;
  events: TaskEvent[];
  inputs: TaskInput[];
  result?: TaskResult;
  finalizing?: boolean;
  uiRequests?: TaskUiRequest[];
}

type Subscriber = (event: TaskEvent) => void;

export class WorkerTaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly subscribers = new Set<Subscriber>();
  private activeTaskId: string | undefined;
  private paused = false;

  constructor(private readonly onChange?: () => void) {}

  pause(): void {
    this.paused = true;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  create(task: TaskSpec): TaskRecord {
    const existing = this.tasks.get(task.taskId);
    if (existing) {
      if (JSON.stringify(existing.task) !== JSON.stringify(task))
        throw new Error("task id already exists with different content");
      return existing;
    }
    const record: TaskRecord = {
      task,
      status: "queued",
      cursor: 0,
      events: [],
      inputs: [],
    };
    this.tasks.set(task.taskId, record);
    if (this.activeTaskId || this.paused) {
      this.emit(task.taskId, "status", { status: "queued" });
    } else {
      this.activeTaskId = task.taskId;
      record.status = "running";
      this.emit(task.taskId, "status", { status: "running" });
    }
    this.changed();
    return record;
  }

  restore(records: TaskRecord[]): void {
    this.tasks.clear();
    this.activeTaskId = undefined;
    for (const record of records) {
      record.finalizing = false;
      record.uiRequests = [];
      if (record.status === "running") {
        record.status = "failed";
        record.result = {
          taskId: record.task.taskId,
          status: "failed",
          error: "Worker restarted while the task was running",
          retryable: true,
        };
        record.events.push({
          taskId: record.task.taskId,
          cursor: ++record.cursor,
          kind: "status",
          payload: {
            status: "failed",
            error: record.result.error,
            retryable: true,
          },
        });
      }
      this.tasks.set(record.task.taskId, record);
    }
    const next = [...this.tasks.values()].find(
      (task) => task.status === "queued",
    );
    if (next) {
      this.activeTaskId = next.task.taskId;
      next.status = "running";
      this.emit(next.task.taskId, "status", { status: "running" });
    }
    this.changed();
  }

  startRestored(): void {
    const active = this.active();
    if (!active || active.status !== "running") return;
    this.emit(active.task.taskId, "status", { status: "running" });
    this.changed();
  }

  exportState(): TaskRecord[] {
    return [...this.tasks.values()].map((record) => ({
      ...record,
      events: [...record.events],
      inputs: [...record.inputs],
    }));
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  active(): TaskRecord | undefined {
    return this.activeTaskId ? this.tasks.get(this.activeTaskId) : undefined;
  }

  snapshot(taskId: string): TaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task not found");
    return {
      taskId,
      status: task.status,
      cursor: task.cursor,
      ...(task.result ? { result: task.result } : {}),
      ...(task.finalizing ? { finalizing: true } : {}),
      ...(task.uiRequests?.length ? { uiRequests: task.uiRequests } : {}),
    };
  }

  eventsAfter(taskId: string, afterCursor: number): TaskEvent[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task not found");
    return task.events.filter((event) => event.cursor > afterCursor);
  }

  input(input: TaskInput): TaskRecord {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error("task not found");
    const previous = input.id
      ? task.inputs.find((item) => item.id === input.id)
      : undefined;
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(input))
        throw new Error("input id already exists with different content");
      return task;
    }
    if (task.status !== "running" && task.status !== "queued")
      throw new Error("task is not active");
    task.inputs.push(input);
    this.emit(input.taskId, "message", { ...input });
    this.changed();
    return task;
  }

  requestUi(taskId: string, request: TaskUiRequest): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;
    task.uiRequests = [
      ...(task.uiRequests ?? []).filter((item) => item.id !== request.id),
      request,
    ];
    this.changed();
  }

  answerUi(response: TaskUiResponse): void {
    const task = this.tasks.get(response.taskId);
    const request = task?.uiRequests?.find((item) => item.id === response.id);
    if (!task || task.status !== "running" || !request)
      throw new Error("remote dialog is no longer pending");
    if (
      !response.cancelled &&
      (request.method === "confirm"
        ? typeof response.confirmed !== "boolean"
        : typeof response.value !== "string")
    )
      throw new Error("invalid remote dialog response");
    if (
      request.method === "select" &&
      !response.cancelled &&
      !request.options?.includes(response.value!)
    )
      throw new Error("invalid remote dialog option");
    task.uiRequests = task.uiRequests!.filter(
      (item) => item.id !== response.id,
    );
    this.changed();
  }

  abort(taskId: string, deferRelease = false): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task not found");
    if (task.status === "aborted") return task;
    if (task.status !== "running" && task.status !== "queued")
      throw new Error("task is not active");
    task.status = "aborted";
    task.finalizing = deferRelease && this.activeTaskId === taskId;
    task.uiRequests = [];
    task.result = { taskId, status: "aborted" };
    this.emit(taskId, "status", { status: "aborted", finalizing: task.finalizing });
    if (this.activeTaskId === taskId && !deferRelease) this.activateNext();
    this.changed();
    return task;
  }

  complete(result: TaskResult): TaskRecord {
    const task = this.tasks.get(result.taskId);
    if (!task) throw new Error("task not found");
    task.status = result.status;
    task.finalizing = false;
    task.uiRequests = [];
    task.result = result;
    this.emit(result.taskId, "status", { ...result });
    if (this.activeTaskId === result.taskId) this.activateNext();
    this.changed();
    return task;
  }

  settle(
    taskId: string,
    status: Extract<TaskStatus, "completed" | "failed">,
    payload: Record<string, unknown> = {},
  ): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task not found");
    task.status = status;
    task.finalizing = false;
    task.uiRequests = [];
    task.result = { ...payload, taskId, status };
    this.emit(taskId, "status", { ...payload, status });
    if (this.activeTaskId === taskId) this.activateNext();
    this.changed();
    return task;
  }

  log(taskId: string, payload: Record<string, unknown>): TaskEvent {
    const event = this.emit(taskId, "log", payload);
    this.changed();
    return event;
  }

  private activateNext(): void {
    this.activeTaskId = undefined;
    if (this.paused) return;
    const next = [...this.tasks.values()].find(
      (task) => task.status === "queued",
    );
    if (!next) return;
    this.activeTaskId = next.task.taskId;
    next.status = "running";
    this.emit(next.task.taskId, "status", { status: "running" });
  }

  private changed(): void {
    this.onChange?.();
  }

  private emit(
    taskId: string,
    kind: TaskEvent["kind"],
    payload: Record<string, unknown>,
  ): TaskEvent {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task not found");
    const event: TaskEvent = { taskId, cursor: ++task.cursor, kind, payload };
    task.events.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }
}
