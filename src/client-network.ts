import { request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";

import WebSocket from "ws";

import {
  parseFrame,
  type ProtocolFrame,
  type WorkerIdentity,
} from "./protocol.js";

export interface PairResponse {
  token: string;
  workerId: string;
  certificateFingerprint: string;
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").toLowerCase();
}

function assertPinned(response: IncomingMessage, fingerprint: string): void {
  const socket = response.socket as TLSSocket;
  const actual = socket.getPeerCertificate().fingerprint256;
  if (
    !actual ||
    normalizeFingerprint(actual) !== normalizeFingerprint(fingerprint)
  )
    throw new Error("CERTIFICATE_MISMATCH");
}

export class CloudConnection {
  constructor(
    readonly baseUrl: string,
    readonly fingerprint: string,
    private token?: string,
  ) {}

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
    let value: PairResponse;
    try {
      value = JSON.parse(response.toString("utf8")) as PairResponse;
    } catch {
      throw new Error("invalid pairing response");
    }
    if (!value.token || !value.workerId || !value.certificateFingerprint)
      throw new Error("invalid pairing response");
    this.token = value.token;
    return value;
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
        rejectUnauthorized: false,
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("upgrade", (response: IncomingMessage) => {
        try {
          assertPinned(response, this.fingerprint);
        } catch (error) {
          socket.terminate();
          reject(error);
        }
      });
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.on("message", (data) => {
      try {
        onFrame(parseFrame(data.toString()));
      } catch {
        socket.close(1003, "invalid protocol frame");
      }
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
    },
  ): Promise<Buffer> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string | number> = {};
    if (options.body)
      headers["content-length"] = Buffer.byteLength(options.body);
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.authenticated && this.token)
      headers.authorization = `Bearer ${this.token}`;
    const requestOptions: RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      rejectUnauthorized: false,
      headers,
    };
    return new Promise((resolve, reject) => {
      const req = request(requestOptions, (response) => {
        try {
          assertPinned(response, this.fingerprint);
        } catch (error) {
          req.destroy();
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if ((response.statusCode ?? 500) >= 400)
            reject(
              new Error(body.toString("utf8") || `HTTP_${response.statusCode}`),
            );
          else resolve(body);
        });
      });
      req.on("error", reject);
      if (options.body) req.write(options.body);
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
