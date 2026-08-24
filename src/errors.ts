import type { ErrorCode, ProtocolError } from "./protocol.js";

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
