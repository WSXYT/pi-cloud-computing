import { PROTOCOL_VERSION } from "./version.js";

export type Locale = "zh-CN" | "en";
export type RunnerMode = "docker" | "host";
export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted";
export type InputDelivery = "prompt" | "steer" | "followUp";

export type ErrorCode =
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "INVALID_FRAME"
  | "AUTH_REQUIRED"
  | "AUTH_REJECTED"
  | "PAIRING_CODE_INVALID"
  | "PAIRING_CODE_EXPIRED"
  | "CERTIFICATE_MISMATCH"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_ACTIVE"
  | "TASK_NOT_ACTIVE"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_HASH_MISMATCH"
  | "GIT_REQUIRED"
  | "SESSION_INVALID"
  | "COMPATIBILITY_WARNING"
  | "SECRET_NOT_AUTHORIZED"
  | "INTERNAL_ERROR";

export interface ProtocolError {
  code: ErrorCode;
  params?: Record<string, string | number | boolean>;
  retryable: boolean;
}

export interface WorkerCapabilities {
  piVersion: string;
  nodeVersion: string;
  gitVersion: string;
  runners: RunnerMode[];
  maxArtifactBytes: number;
  dockerAvailable: boolean;
}

export interface WorkerIdentity {
  workerId: string;
  address: string;
  certificateFingerprint: string;
  capabilities: WorkerCapabilities;
}

export interface ArtifactDescriptor {
  id: string;
  kind: "workspace" | "environment" | "session" | "secret-bundle" | "result";
  size: number;
  sha256: string;
  contentType: string;
}

export interface EnvironmentManifest {
  piVersion: string;
  nodeVersion: string;
  platform: string;
  packages: Array<{ source: string; version?: string; enabled: boolean }>;
  resources: Array<{
    kind: "extension" | "skill" | "prompt" | "theme";
    path: string;
    sha256: string;
  }>;
  providers: Array<{ id: string; models: string[]; configSha256: string }>;
  secretVersions: Array<{
    id: string;
    version: number;
    sha256: string;
    authorized: boolean;
  }>;
  warnings: Array<{
    code:
      | "WARN_PLUGIN_PLATFORM_MISMATCH"
      | "WARN_ABSOLUTE_PATH"
      | "WARN_NATIVE_DEPENDENCY";
    path?: string;
  }>;
}

export interface GitBaseline {
  repositoryHash: string;
  head: string;
  indexHash: string;
  worktreeHash: string;
  includedPaths: string[];
}

export interface SessionCursor {
  sessionId: string;
  baseLeafId: string | null;
  lastEntryId: string | null;
  entriesSha256: string;
}

export interface TaskInput {
  taskId: string;
  delivery: InputDelivery;
  message: string;
}

export interface TaskSpec {
  taskId: string;
  projectId: string;
  prompt: string;
  runner: RunnerMode;
  environment: EnvironmentManifest;
  git: GitBaseline;
  session: SessionCursor;
  artifacts: ArtifactDescriptor[];
  secretIds: string[];
}

export interface TaskEvent {
  taskId: string;
  cursor: number;
  kind: "status" | "message" | "tool" | "warning" | "log";
  payload: Record<string, unknown>;
}

export interface TaskResult {
  taskId: string;
  status: Extract<TaskStatus, "completed" | "failed" | "aborted">;
  git: GitBaseline & { resultCommit: string; patchArtifactId: string };
  session: SessionCursor & {
    remoteSessionArtifactId: string;
    newEntryCount: number;
  };
  warnings: string[];
  artifacts: ArtifactDescriptor[];
}

export type ClientFrame =
  | { type: "hello"; protocolVersion: number; clientId: string }
  | { type: "pair"; code: string }
  | { type: "task_create"; task: TaskSpec }
  | { type: "task_input"; input: TaskInput }
  | { type: "task_abort"; taskId: string }
  | { type: "task_resume"; taskId: string; afterCursor: number };

export type WorkerFrame =
  | { type: "hello_ack"; protocolVersion: number; worker: WorkerIdentity }
  | { type: "pair_result"; worker: WorkerIdentity; token: string }
  | { type: "task_accepted"; taskId: string; status: TaskStatus }
  | { type: "task_event"; event: TaskEvent }
  | { type: "task_result"; result: TaskResult }
  | { type: "error"; requestType?: ClientFrame["type"]; error: ProtocolError };

export type ProtocolFrame = ClientFrame | WorkerFrame;

const CLIENT_TYPES = new Set<ClientFrame["type"]>([
  "hello",
  "pair",
  "task_create",
  "task_input",
  "task_abort",
  "task_resume",
]);
const WORKER_TYPES = new Set<WorkerFrame["type"]>([
  "hello_ack",
  "pair_result",
  "task_accepted",
  "task_event",
  "task_result",
  "error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a finite number`);
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function parseTaskSpec(value: unknown): TaskSpec {
  const task = requireObject(value, "task");
  requireString(task.taskId, "task.taskId");
  requireString(task.projectId, "task.projectId");
  requireString(task.prompt, "task.prompt");
  if (task.runner !== "docker" && task.runner !== "host")
    throw new Error("task.runner is invalid");
  // SAFETY: required TaskSpec fields are checked above; nested manifests are validated by the upload layer.
  return task as unknown as TaskSpec;
}

function parseTaskInput(value: unknown): TaskInput {
  const input = requireObject(value, "input");
  requireString(input.taskId, "input.taskId");
  requireString(input.message, "input.message");
  if (
    input.delivery !== "prompt" &&
    input.delivery !== "steer" &&
    input.delivery !== "followUp"
  ) {
    throw new Error("input.delivery is invalid");
  }
  // SAFETY: taskId, delivery, and message are checked above before transport use.
  return input as unknown as TaskInput;
}

function validateTopLevelFrame(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("frame must be an object");
  const type = requireString(value.type, "type");
  if (
    !CLIENT_TYPES.has(type as ClientFrame["type"]) &&
    !WORKER_TYPES.has(type as WorkerFrame["type"])
  ) {
    throw new Error(`unknown frame type: ${type}`);
  }
  return value;
}

export function assertProtocolVersion(
  version: unknown,
): asserts version is typeof PROTOCOL_VERSION {
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version: ${String(version)}`);
  }
}

export function parseFrame(json: string): ProtocolFrame {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("frame is not valid JSON");
  }
  const frame = validateTopLevelFrame(value);
  switch (frame.type) {
    case "hello":
      assertProtocolVersion(frame.protocolVersion);
      return {
        type: "hello",
        protocolVersion: frame.protocolVersion,
        clientId: requireString(frame.clientId, "clientId"),
      };
    case "pair":
      return { type: "pair", code: requireString(frame.code, "code") };
    case "task_create":
      return { type: "task_create", task: parseTaskSpec(frame.task) };
    case "task_input":
      return { type: "task_input", input: parseTaskInput(frame.input) };
    case "task_abort":
      return {
        type: "task_abort",
        taskId: requireString(frame.taskId, "taskId"),
      };
    case "task_resume":
      return {
        type: "task_resume",
        taskId: requireString(frame.taskId, "taskId"),
        afterCursor: requireNumber(frame.afterCursor, "afterCursor"),
      };
    default:
      // SAFETY: worker frames are decoded by the worker-side handler before use;
      // this parser preserves their JSON shape for transport clients.
      return frame as unknown as ProtocolFrame;
  }
}

export function encodeFrame(frame: ProtocolFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
