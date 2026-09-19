import { PROTOCOL_VERSION } from "./version.js";
import {
  decodeBase64,
  validateIdentifier,
  validateRelativePath,
} from "./paths.js";

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
  dockerNetwork?: "none" | "bridge";
  runtimeArchiveVersion?: 1;
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
  id?: string;
  delivery: InputDelivery;
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export interface TaskUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
}

export interface TaskUiResponse {
  taskId: string;
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface TaskSpec {
  taskId: string;
  projectId: string;
  prompt: string;
  model?: { provider: string; id: string; thinkingLevel?: string };
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
  resultArtifactId?: string;
  sessionArtifactId?: string;
  changedFiles?: number;
  error?: string;
  retryable?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface TaskSnapshot {
  finalizing?: boolean;
  taskId: string;
  status: TaskStatus;
  cursor: number;
  result?: TaskResult;
  uiRequests?: TaskUiRequest[];
}

export type ClientFrame =
  | { type: "hello"; protocolVersion: number; clientId: string }
  | { type: "pair"; code: string }
  | { type: "task_create"; task: TaskSpec }
  | { type: "task_input"; input: TaskInput }
  | { type: "task_ui_response"; response: TaskUiResponse }
  | { type: "task_abort"; taskId: string }
  | { type: "task_resume"; taskId: string; afterCursor: number }
  | { type: "task_status"; taskId: string };

export type WorkerFrame =
  | { type: "hello_ack"; protocolVersion: number; worker: WorkerIdentity }
  | { type: "pair_result"; worker: WorkerIdentity; token: string }
  | { type: "task_accepted"; taskId: string; status: TaskStatus }
  | { type: "task_input_accepted"; taskId: string; inputId: string }
  | { type: "task_event"; event: TaskEvent }
  | { type: "task_result"; result: TaskResult }
  | { type: "task_state"; state: TaskSnapshot }
  | { type: "error"; requestType?: ClientFrame["type"]; error: ProtocolError };

export type ProtocolFrame = ClientFrame | WorkerFrame;

const CLIENT_TYPES = new Set<ClientFrame["type"]>([
  "hello",
  "pair",
  "task_create",
  "task_input",
  "task_ui_response",
  "task_abort",
  "task_resume",
  "task_status",
]);
const WORKER_TYPES = new Set<WorkerFrame["type"]>([
  "hello_ack",
  "pair_result",
  "task_accepted",
  "task_input_accepted",
  "task_event",
  "task_result",
  "task_state",
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

function requireCounter(value: unknown, name: string): number {
  const number = requireNumber(value, name);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid ${name}`);
  return number;
}

function requireStatus(value: unknown): TaskStatus {
  if (value !== "queued" && value !== "running" && value !== "completed" && value !== "failed" && value !== "aborted") throw new Error("invalid task status");
  return value;
}

export function parseWorkerIdentity(value: unknown): WorkerIdentity {
  const worker = requireObject(value, "worker");
  validateIdentifier(worker.workerId);
  requireString(worker.address, "worker.address");
  requireString(worker.certificateFingerprint, "worker.certificateFingerprint");
  const capabilities = requireObject(worker.capabilities, "worker.capabilities");
  for (const key of ["piVersion", "nodeVersion", "gitVersion"]) requireString(capabilities[key], `capabilities.${key}`);
  if (!Array.isArray(capabilities.runners) || !capabilities.runners.length || capabilities.runners.some((runner) => runner !== "host" && runner !== "docker")) throw new Error("invalid Worker runners");
  if (!requireCounter(capabilities.maxArtifactBytes, "maxArtifactBytes") || typeof capabilities.dockerAvailable !== "boolean") throw new Error("invalid Worker capabilities");
  if (capabilities.dockerNetwork !== undefined && capabilities.dockerNetwork !== "none" && capabilities.dockerNetwork !== "bridge") throw new Error("invalid Docker network");
  // SAFETY: all identity fields consumed by the client have been validated; archive versions are negotiated separately.
  return worker as unknown as WorkerIdentity;
}

function parseTaskResult(value: unknown): TaskResult {
  const result = requireObject(value, "result");
  validateIdentifier(result.taskId);
  const status = requireStatus(result.status);
  if (status === "running" || status === "queued") throw new Error("result must be terminal");
  for (const key of ["resultArtifactId", "sessionArtifactId"]) if (result[key] !== undefined) validateIdentifier(result[key]);
  if (result.error !== undefined && typeof result.error !== "string") throw new Error("invalid result error");
  if (result.retryable !== undefined && typeof result.retryable !== "boolean") throw new Error("invalid result retryability");
  if (result.changedFiles !== undefined) requireCounter(result.changedFiles, "changedFiles");
  if (result.exitCode !== undefined && result.exitCode !== null) requireNumber(result.exitCode, "exitCode");
  if (result.signal !== undefined && result.signal !== null) requireString(result.signal, "signal");
  // SAFETY: terminal status, artifact identities and result scalar fields are validated above.
  return result as unknown as TaskResult;
}

function parseTaskSpec(value: unknown): TaskSpec {
  const task = requireObject(value, "task");
  validateIdentifier(task.taskId);
  requireString(task.projectId, "task.projectId");
  requireString(task.prompt, "task.prompt");
  if (task.runner !== "docker" && task.runner !== "host")
    throw new Error("task.runner is invalid");
  const git = requireObject(task.git, "task.git");
  for (const key of ["head", "indexHash", "repositoryHash", "worktreeHash"])
    requireString(git[key], `task.git.${key}`);
  if (!Array.isArray(git.includedPaths))
    throw new Error("task.git.includedPaths is invalid");
  git.includedPaths.forEach(validateRelativePath);
  const session = requireObject(task.session, "task.session");
  requireString(session.sessionId, "task.session.sessionId");
  requireString(session.entriesSha256, "task.session.entriesSha256");
  for (const key of ["baseLeafId", "lastEntryId"])
    if (session[key] !== null)
      requireString(session[key], `task.session.${key}`);
  const environment = requireObject(task.environment, "task.environment");
  for (const key of [
    "packages",
    "resources",
    "providers",
    "secretVersions",
    "warnings",
  ])
    if (!Array.isArray(environment[key]))
      throw new Error(`task.environment.${key} is invalid`);
  if (!Array.isArray(task.artifacts) || !Array.isArray(task.secretIds))
    throw new Error("task artifacts/secretIds are invalid");
  for (const raw of task.artifacts) {
    const artifact = requireObject(raw, "artifact");
    validateIdentifier(artifact.id);
    if (
      ![
        "workspace",
        "environment",
        "session",
        "secret-bundle",
        "result",
      ].includes(String(artifact.kind))
    )
      throw new Error("invalid artifact kind");
    const size = requireNumber(artifact.size, "artifact.size");
    if (!Number.isSafeInteger(size) || size < 0 || size > 50 * 1024 * 1024)
      throw new Error("invalid artifact size");
    if (
      !/^[a-f0-9]{64}$/.test(requireString(artifact.sha256, "artifact.sha256"))
    )
      throw new Error("invalid artifact hash");
  }
  task.secretIds.forEach(validateIdentifier);
  if (task.model !== undefined) {
    const model = requireObject(task.model, "task.model");
    requireString(model.id, "task.model.id");
    requireString(model.provider, "task.model.provider");
    if (
      model.thinkingLevel !== undefined &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        String(model.thinkingLevel),
      )
    )
      throw new Error("invalid thinking level");
  }
  // SAFETY: transport fields and bounds are validated above; uploaded content is verified separately before materialization.
  return task as unknown as TaskSpec;
}

export function parseTaskInput(value: unknown): TaskInput {
  const input = requireObject(value, "input");
  validateIdentifier(input.taskId);
  if (input.id !== undefined) validateIdentifier(input.id);
  if (typeof input.message !== "string" || (!input.message && !(Array.isArray(input.images) && input.images.length))) throw new Error("input.message or images are required");
  if (Buffer.byteLength(JSON.stringify(input)) > 49 * 1024 * 1024) throw new Error("input exceeds frame limit");
  if (
    input.delivery !== "prompt" &&
    input.delivery !== "steer" &&
    input.delivery !== "followUp"
  ) {
    throw new Error("input.delivery is invalid");
  }
  if (input.images !== undefined) {
    if (!Array.isArray(input.images) || input.images.length > 10)
      throw new Error("invalid input images");
    for (const item of input.images) {
      const image = requireObject(item, "image");
      if (
        image.type !== "image" ||
        !/^image\/(?:png|jpeg|webp|gif)$/.test(String(image.mimeType)) ||
        decodeBase64(image.data).length > 5 * 1024 * 1024
      )
        throw new Error("invalid input image");
    }
  }
  // SAFETY: every input field consumed by RPC is validated above.
  return input as unknown as TaskInput;
}

export function parseTaskUiRequest(value: unknown): TaskUiRequest {
  const request = requireObject(value, "UI request");
  validateIdentifier(request.id);
  if (
    !["select", "confirm", "input", "editor"].includes(String(request.method))
  )
    throw new Error("unsupported remote dialog");
  requireString(request.title, "UI title");
  if (
    request.options !== undefined &&
    (!Array.isArray(request.options) ||
      request.options.length > 100 ||
      request.options.some((item) => typeof item !== "string"))
  )
    throw new Error("invalid remote dialog options");
  for (const key of ["message", "placeholder", "prefill"])
    if (request[key] !== undefined && typeof request[key] !== "string")
      throw new Error("invalid remote dialog text");
  // SAFETY: the dialog identity, method and optional text/options have been checked.
  return request as unknown as TaskUiRequest;
}

function parseTaskUiResponse(value: unknown): TaskUiResponse {
  const response = requireObject(value, "UI response");
  validateIdentifier(response.taskId);
  validateIdentifier(response.id);
  if (response.value !== undefined && typeof response.value !== "string")
    throw new Error("invalid UI value");
  for (const key of ["confirmed", "cancelled"])
    if (response[key] !== undefined && typeof response[key] !== "boolean")
      throw new Error("invalid UI response");
  // SAFETY: response scalars are checked here; the pending dialog validates the chosen option.
  return response as unknown as TaskUiResponse;
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
    case "task_ui_response":
      return {
        type: "task_ui_response",
        response: parseTaskUiResponse(frame.response),
      };
    case "task_abort":
      return {
        type: "task_abort",
        taskId: requireString(frame.taskId, "taskId"),
      };
    case "task_resume":
      if (
        !Number.isSafeInteger(frame.afterCursor) ||
        Number(frame.afterCursor) < 0
      )
        throw new Error("invalid event cursor");
      return {
        type: "task_resume",
        taskId: requireString(frame.taskId, "taskId"),
        afterCursor: requireNumber(frame.afterCursor, "afterCursor"),
      };
    case "task_status":
      return {
        type: "task_status",
        taskId: requireString(frame.taskId, "taskId"),
      };
    case "hello_ack":
    case "pair_result":
      if (frame.type === "hello_ack") assertProtocolVersion(frame.protocolVersion);
      else requireString(frame.token, "token");
      frame.worker = parseWorkerIdentity(frame.worker);
      break;
    case "task_accepted":
      validateIdentifier(frame.taskId);
      requireStatus(frame.status);
      break;
    case "task_input_accepted":
      validateIdentifier(frame.taskId);
      validateIdentifier(frame.inputId);
      break;
    case "task_event": {
      const event = requireObject(frame.event, "event");
      validateIdentifier(event.taskId);
      requireCounter(event.cursor, "cursor");
      if (!["status", "message", "tool", "warning", "log"].includes(String(event.kind))) throw new Error("invalid event kind");
      requireObject(event.payload, "event.payload");
      break;
    }
    case "task_result":
      frame.result = parseTaskResult(frame.result);
      break;
    case "task_state": {
      const state = requireObject(frame.state, "state");
      validateIdentifier(state.taskId);
      requireCounter(state.cursor, "cursor");
      requireStatus(state.status);
      if (state.finalizing !== undefined && typeof state.finalizing !== "boolean") throw new Error("invalid finalizing state");
      if (state.result !== undefined) {
        const result = parseTaskResult(state.result);
        if (result.taskId !== state.taskId || result.status !== state.status) throw new Error("result identity/status mismatch");
      }
      if (state.uiRequests !== undefined) {
        if (!Array.isArray(state.uiRequests) || state.uiRequests.length > 100) throw new Error("invalid pending dialogs");
        state.uiRequests.forEach(parseTaskUiRequest);
      }
      break;
    }
    case "error": {
      const error = requireObject(frame.error, "error");
      requireString(error.code, "error.code");
      if (typeof error.retryable !== "boolean") throw new Error("invalid retryability");
      if (error.params !== undefined && Object.values(requireObject(error.params, "error.params")).some((param) => typeof param !== "string" && typeof param !== "boolean" && (typeof param !== "number" || !Number.isFinite(param)))) throw new Error("invalid error parameters");
      if (frame.requestType !== undefined && !CLIENT_TYPES.has(frame.requestType as ClientFrame["type"])) throw new Error("invalid request type");
      break;
    }
  }
  // SAFETY: client frames return above; every Worker frame's consumed fields have been validated in the switch.
  return frame as unknown as WorkerFrame;
}

export function encodeFrame(frame: ProtocolFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
