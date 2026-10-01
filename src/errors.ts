import type { ErrorCode, ProtocolError } from "./protocol.js";

/** Only bounded system codes cross the transport, never exception text or paths. */
export function workerStorageError(error: unknown, operation = "save_task_state"): PiCloudError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return new PiCloudError("WORKER_STORAGE_ERROR", "Worker could not save task state", {
    params: { operation, cause: ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "EIO", "EMFILE", "ENFILE"].includes(code) ? code : "STATE_WRITE_FAILED" },
  });
}

export class PiCloudError extends Error {
  readonly code: ErrorCode;
  readonly params: Record<string, string | number | boolean>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      params?: Record<string, string | number | boolean>;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "PiCloudError";
    this.code = code;
    this.params = options.params ?? {};
    this.retryable = options.retryable ?? false;
  }

  toProtocol(): ProtocolError {
    return {
      code: this.code,
      ...(Object.keys(this.params).length > 0 ? { params: this.params } : {}),
      retryable: this.retryable,
    };
  }
}
