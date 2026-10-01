import { Agent, request, type RequestOptions } from "node:https";
import {
  connect as connectTls,
  type ConnectionOptions,
  type TLSSocket,
} from "node:tls";

import WebSocket from "ws";
import type { SecretMetadata } from "./worker/secrets.js";
import { sha256 } from "./environment.js";
import { validateIdentifier } from "./paths.js";

import {
  parseFrame,
  parseWorkerIdentity,
  type ProtocolFrame,
  type WorkerIdentity,
} from "./protocol.js";

export interface PairResponse {
  token: string;
  workerId: string;
  certificateFingerprint: string;
}

export function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").trim().toLowerCase();
}

function assertPinned(socket: TLSSocket, fingerprint: string): void {
  const actual = socket.getPeerCertificate().fingerprint256;
  if (
    !actual ||
    normalizeFingerprint(actual) !== normalizeFingerprint(fingerprint)
  )
    throw new Error("CERTIFICATE_MISMATCH");
}

// Release the socket to HTTP/WS only after the TLS pin has been checked.
// Checking an HTTP response is too late: its request may already contain secrets.
function pinnedAgent(fingerprint: string): Agent {
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  agent.createConnection = (options, callback) => {
    const socket = connectTls({
      ...(options as ConnectionOptions),
      rejectUnauthorized: false,
    });
    const fail = (error: Error) => callback?.(error, socket);
    const handshakeTimeout = () => {
      socket.destroy(new Error("TLS_HANDSHAKE_TIMEOUT"));
    };
    socket.once("error", fail);
    socket.setTimeout(15_000, handshakeTimeout);
    socket.once("secureConnect", () => {
      try {
        assertPinned(socket, fingerprint);
      } catch (error) {
        socket.destroy(error as Error);
        return;
      }
      socket.setTimeout(0);
      socket.removeListener("timeout", handshakeTimeout);
      socket.removeListener("error", fail);
      callback?.(null, socket);
    });
    return undefined;
  };
  return agent;
}

function jsonResponse<T>(data: Buffer, decode: (value: unknown) => T): T {
  let value: unknown;
  try { value = JSON.parse(data.toString("utf8")); }
  catch { throw new Error("invalid Worker JSON response"); }
  return decode(value);
}

function parseSecretMetadata(value: unknown): SecretMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid credential metadata");
  const metadata = value as Record<string, unknown>;
  validateIdentifier(metadata.id);
  if (!Number.isSafeInteger(metadata.version) || Number(metadata.version) < 1 || typeof metadata.createdAt !== "string" ||
      (metadata.revokedAt !== undefined && typeof metadata.revokedAt !== "string") ||
      (metadata.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(metadata.sha256)))) throw new Error("invalid credential metadata");
  // SAFETY: the metadata identity, version, timestamps and optional fingerprint are checked above.
  return metadata as unknown as SecretMetadata;
}

export interface TransferProgress {
  phase: "connect" | "upload" | "response" | "download";
  operation: "artifact_probe" | "artifact_upload" | "artifact_download" | "credential_upload" | "credentials" | "worker_info" | "connection";
  totalBytes: number;
  sentBytes: number;
  receivedBytes: number;
  elapsedMs: number;
}

export class CloudRequestError extends Error {
  constructor(readonly code: string, readonly progress: TransferProgress, readonly serverCause?: string) { super(code); }
}

export class CloudConnection {
  private readonly agent: Agent;

  constructor(
    readonly baseUrl: string,
    readonly fingerprint: string,
    private token?: string,
  ) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("Invalid Worker HTTPS address");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(
        "Worker address must be an HTTPS origin, without credentials or a path",
      );
    this.baseUrl = url.origin;
    this.agent = pinnedAgent(fingerprint);
  }

  get accessToken(): string | undefined {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  async pair(code: string): Promise<PairResponse> {
    const response = await this.request("/pair", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    const value = jsonResponse(response, (parsed) => {
      if (!parsed || typeof parsed !== "object") throw new Error("invalid pairing response");
      const value = parsed as Record<string, unknown>;
      if (typeof value.token !== "string" || !value.token || typeof value.workerId !== "string" || typeof value.certificateFingerprint !== "string")
        throw new Error("invalid pairing response");
      validateIdentifier(value.workerId);
      return { token: value.token, workerId: value.workerId, certificateFingerprint: value.certificateFingerprint };
    });
    if (
      normalizeFingerprint(value.certificateFingerprint) !==
      normalizeFingerprint(this.fingerprint)
    )
      throw new Error("CERTIFICATE_MISMATCH");
    this.token = value.token;
    return { token: value.token, workerId: value.workerId, certificateFingerprint: value.certificateFingerprint };
  }

  async hasArtifact(id: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request(`/artifacts/${encodeURIComponent(id)}`, {
        method: "HEAD",
        authenticated: true,
        signal,
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "HTTP_404") return false;
      throw error;
    }
  }

  async upload(
    id: string,
    data: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
    onProgress?: (progress: TransferProgress) => void,
  ): Promise<void> {
    await this.request(`/artifacts/${encodeURIComponent(id)}`, {
      method: "POST",
      body: Buffer.from(data),
      contentType,
      authenticated: true,
      signal,
      onProgress,
    });
  }

  async workerInfo(signal?: AbortSignal): Promise<WorkerIdentity> {
    return jsonResponse(await this.request("/worker/manifest", { method: "GET", authenticated: true, signal }), (value) => {
      if (!value || typeof value !== "object" || !("worker" in value)) throw new Error("Worker upgrade required: missing capabilities");
      return parseWorkerIdentity(value.worker);
    });
  }

  async listSecrets(signal?: AbortSignal): Promise<SecretMetadata[]> {
    return jsonResponse(await this.request("/secrets", { method: "GET", authenticated: true, signal }), (value) => {
      if (!Array.isArray(value)) throw new Error("invalid Worker credential metadata");
      return value.map(parseSecretMetadata);
    });
  }

  async revokeToken(): Promise<void> {
    await this.request("/tokens/current", { method: "DELETE", authenticated: true });
  }

  async uploadSecret(id: string, value: string, version = 1, signal?: AbortSignal): Promise<SecretMetadata> {
    const response = await this.request(`/secrets/${encodeURIComponent(id)}`, {
      method: "POST",
      body: value,
      contentType: "application/json",
      authenticated: true,
      headers: { "x-secret-version": String(version) },
      signal,
    });
    const metadata = jsonResponse(response, parseSecretMetadata);
    if (metadata.id !== id || metadata.version !== version || metadata.sha256 !== sha256(value)) throw new Error("invalid credential upload response");
    return metadata;
  }

  async revokeSecret(id: string): Promise<void> {
    await this.request(`/secrets/${encodeURIComponent(id)}`, {
      method: "DELETE",
      authenticated: true,
    });
  }

  async download(id: string, signal?: AbortSignal): Promise<Buffer> {
    return this.request(`/artifacts/${encodeURIComponent(id)}`, {
      method: "GET",
      authenticated: true,
      signal,
    });
  }

  async openEvents(
    onFrame: (frame: ProtocolFrame) => void,
  ): Promise<WebSocket> {
    if (!this.token) throw new Error("AUTH_REQUIRED");
    const socket = new WebSocket(
      `${this.baseUrl.replace(/^https:/, "wss:")}/events`,
      {
        agent: this.agent,
        handshakeTimeout: 10_000,
        maxPayload: 50 * 1024 * 1024,
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    socket.on("message", (data) => {
      try {
        onFrame(parseFrame(data.toString()));
      } catch {
        socket.close(1003, "invalid protocol frame");
      }
    });
    // Keep a listener after the opening promise resolves; close drives recovery.
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("close", () =>
        reject(new Error("WebSocket closed before opening")),
      );
    });
    return socket;
  }

  send(socket: WebSocket, frame: ProtocolFrame): void {
    socket.send(JSON.stringify(frame));
  }

  private async request(
    path: string,
    options: {
      method: string;
      body?: string | Buffer;
      contentType?: string;
      authenticated?: boolean;
      headers?: Record<string, string>;
      signal?: AbortSignal | undefined;
      onProgress?: ((progress: TransferProgress) => void) | undefined;
    },
  ): Promise<Buffer> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string | number> = { ...options.headers };
    if (options.body)
      headers["content-length"] = Buffer.byteLength(options.body);
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.authenticated && this.token)
      headers.authorization = `Bearer ${this.token}`;
    if (options.signal?.aborted) throw new Error("CLOUD_CANCELLED");
    const requestOptions: RequestOptions = {
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      agent: this.agent,
      headers,
    };
    const started = Date.now();
    const data = options.body === undefined ? undefined : Buffer.from(options.body);
    let operation: TransferProgress["operation"] = "connection";
    if (path.startsWith("/artifacts/")) {
      operation = "artifact_download";
      if (options.method === "HEAD") operation = "artifact_probe";
      if (options.method === "POST") operation = "artifact_upload";
    } else if (path.startsWith("/secrets")) operation = options.method === "POST" ? "credential_upload" : "credentials";
    else if (path === "/worker/manifest") operation = "worker_info";
    const progress: TransferProgress = { phase: "connect", operation, totalBytes: data?.length ?? 0, sentBytes: 0, receivedBytes: 0, elapsedMs: 0 };
    const snapshot = (): TransferProgress => ({ ...progress, elapsedMs: Date.now() - started });
    const report = () => options.onProgress?.(snapshot());
    return new Promise((resolve, reject) => {
      let settled = false;
      let onAbort: (() => void) | undefined;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(connectTimer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : (error as NodeJS.ErrnoException).code ?? "NETWORK_ERROR";
        reject(error instanceof CloudRequestError ? error : new CloudRequestError(/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "NETWORK_ERROR", snapshot()));
      };
      const req = request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on("error", fail);
        response.on("aborted", () => fail(new Error("RESPONSE_INTERRUPTED")));
        response.on("data", (chunk: Buffer) => {
          progress.phase = options.method === "GET" ? "download" : "response";
          progress.receivedBytes += chunk.length;
          if (progress.receivedBytes > 50 * 1024 * 1024) {
            response.destroy(new Error("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(Buffer.from(chunk));
          report();
        });
        response.on("end", () => {
          if (settled) return;
          const body = Buffer.concat(chunks);
          if ((response.statusCode ?? 500) >= 400) {
            let code = `HTTP_${response.statusCode}`;
            let serverCause: string | undefined;
            try {
              const value = JSON.parse(body.toString("utf8")) as { error?: unknown; params?: { cause?: unknown } };
              if (typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.error)) code = value.error;
              if (typeof value.params?.cause === "string" && /^[A-Z_]{1,32}$/.test(value.params.cause)) serverCause = value.params.cause;
            } catch { /* Never echo raw proxy/HTTP exceptions. */ }
            fail(new CloudRequestError(code, snapshot(), serverCause));
            req.destroy();
          } else {
            settled = true;
            cleanup();
            resolve(body);
          }
        });
      });
      onAbort = () => req.destroy(new Error("CLOUD_CANCELLED"));
      req.on("error", fail);
      req.once("socket", () => {
        clearTimeout(connectTimer);
        progress.phase = data?.length ? "upload" : "response";
        report();
      });
      req.once("finish", () => { progress.phase = "response"; report(); });
      connectTimer = setTimeout(() => req.destroy(new Error("CONNECTION_TIMEOUT")), 15_000);
      connectTimer.unref();
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      }
      req.setTimeout(30_000, () => req.destroy(new Error("HTTP_RESPONSE_TIMEOUT")));
      void (async () => {
        // Bound queued bytes; callbacks describe local socket progress, not remote acknowledgement.
        for (let offset = 0; data && offset < data.length && !settled; offset += 64 * 1024) {
          const chunk = data.subarray(offset, offset + 64 * 1024);
          await new Promise<void>((done, rejectWrite) => req.write(chunk, (error) => error ? rejectWrite(error) : done()));
          progress.sentBytes += chunk.length;
          report();
        }
        if (!settled) req.end();
      })().catch(fail);
    });
  }
}

export function workerFromPair(
  response: PairResponse,
  baseUrl: string,
): WorkerIdentity {
  return {
    workerId: response.workerId,
    address: baseUrl,
    certificateFingerprint: response.certificateFingerprint,
    capabilities: {
      piVersion: "unknown",
      nodeVersion: "unknown",
      gitVersion: "unknown",
      runners: ["host", "docker"],
      maxArtifactBytes: 50 * 1024 * 1024,
      dockerAvailable: true,
    },
  };
}
