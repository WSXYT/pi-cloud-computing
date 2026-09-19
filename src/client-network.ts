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
    socket.once("error", fail);
    socket.setTimeout(15_000, () =>
      socket.destroy(new Error("TLS connection timed out")),
    );
    socket.once("secureConnect", () => {
      try {
        assertPinned(socket, fingerprint);
      } catch (error) {
        socket.destroy(error as Error);
        return;
      }
      socket.setTimeout(0);
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

  async hasArtifact(id: string): Promise<boolean> {
    try {
      await this.request(`/artifacts/${encodeURIComponent(id)}`, {
        method: "HEAD",
        authenticated: true,
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
  ): Promise<void> {
    await this.request(`/artifacts/${encodeURIComponent(id)}`, {
      method: "POST",
      body: Buffer.from(data),
      contentType,
      authenticated: true,
    });
  }

  async workerInfo(): Promise<WorkerIdentity> {
    return jsonResponse(await this.request("/worker/manifest", { method: "GET", authenticated: true }), (value) => {
      if (!value || typeof value !== "object" || !("worker" in value)) throw new Error("Worker upgrade required: missing capabilities");
      return parseWorkerIdentity(value.worker);
    });
  }

  async listSecrets(): Promise<SecretMetadata[]> {
    return jsonResponse(await this.request("/secrets", { method: "GET", authenticated: true }), (value) => {
      if (!Array.isArray(value)) throw new Error("invalid Worker credential metadata");
      return value.map(parseSecretMetadata);
    });
  }

  async revokeToken(): Promise<void> {
    await this.request("/tokens/current", { method: "DELETE", authenticated: true });
  }

  async uploadSecret(id: string, value: string, version = 1): Promise<SecretMetadata> {
    const response = await this.request(`/secrets/${encodeURIComponent(id)}`, {
      method: "POST",
      body: value,
      contentType: "application/json",
      authenticated: true,
      headers: { "x-secret-version": String(version) },
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

  async download(id: string): Promise<Buffer> {
    return this.request(`/artifacts/${encodeURIComponent(id)}`, {
      method: "GET",
      authenticated: true,
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
        handshakeTimeout: 30_000,
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
    },
  ): Promise<Buffer> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string | number> = { ...options.headers };
    if (options.body)
      headers["content-length"] = Buffer.byteLength(options.body);
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.authenticated && this.token)
      headers.authorization = `Bearer ${this.token}`;
    const requestOptions: RequestOptions = {
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      agent: this.agent,
      headers,
    };
    return new Promise((resolve, reject) => {
      const req = request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Response interrupted")));
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 50 * 1024 * 1024) {
            response.destroy(new Error("Response exceeds artifact size limit"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if ((response.statusCode ?? 500) >= 400) {
            let message = `HTTP_${response.statusCode}`;
            try {
              const value = JSON.parse(body.toString("utf8")) as { error?: unknown };
              if (typeof value.error === "string") message = value.error;
            } catch { /* Don't echo an unstructured proxy page or server body into Pi. */ }
            reject(new Error(message));
          } else resolve(body);
        });
      });
      req.on("error", reject);
      req.setTimeout(30_000, () =>
        req.destroy(new Error("Worker request timed out")),
      );
      if (options.body !== undefined) req.write(options.body);
      req.end();
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
