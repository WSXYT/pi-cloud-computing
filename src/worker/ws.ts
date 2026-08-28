import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import { encodeFrame, parseFrame, type WorkerIdentity } from "../protocol.js";
import { authenticateToken } from "./pairing.js";
import type { WorkerState } from "./state.js";
import type { WorkerTaskManager } from "./tasks.js";

export interface TaskSocket {
  close(): Promise<void>;
}

function tokenFrom(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

export function attachTaskWebSocket(
  server: HttpServer,
  state: WorkerState,
  identity: WorkerIdentity,
  tasks: WorkerTaskManager,
): TaskSocket {
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  const send = (
    socket: WebSocket,
    frame: Parameters<typeof encodeFrame>[0],
  ): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(frame));
  };
  const sendState = (socket: WebSocket, taskId: string): void => {
    const snapshot = tasks.snapshot(taskId);
    send(socket, { type: "task_state", state: snapshot });
    if (snapshot.result)
      send(socket, { type: "task_result", result: snapshot.result });
  };
  const unsubscribe = tasks.subscribe((event) => {
    const message = encodeFrame({ type: "task_event", event });
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    if (
      ["completed", "failed", "aborted"].includes(String(event.payload.status))
    ) {
      try {
        for (const socket of sockets) sendState(socket, event.taskId);
      } catch {
        // The event remains durable and can be replayed after reconnect.
      }
    }
  });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(
      request.url ?? "/",
      `https://${request.headers.host ?? "localhost"}`,
    );
    if (
      url.pathname !== "/events" ||
      !authenticateToken(state, tokenFrom(request) ?? "")
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) =>
      wss.emit("connection", client, request),
    );
  };
  server.on("upgrade", upgrade);
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      try {
        const frame = parseFrame(raw.toString());
        if (frame.type === "hello")
          socket.send(
            encodeFrame({
              type: "hello_ack",
              protocolVersion: 1,
              worker: identity,
            }),
          );
        else if (frame.type === "task_create") {
          const record = tasks.create(frame.task);
          socket.send(
            encodeFrame({
              type: "task_accepted",
              taskId: record.task.taskId,
              status: record.status,
            }),
          );
        } else if (frame.type === "task_input") {
          const record = tasks.input(frame.input);
          socket.send(
            encodeFrame({
              type: "task_accepted",
              taskId: record.task.taskId,
              status: record.status,
            }),
          );
        } else if (frame.type === "task_abort") {
          const record = tasks.abort(frame.taskId);
          socket.send(
            encodeFrame({
              type: "task_accepted",
              taskId: record.task.taskId,
              status: record.status,
            }),
          );
        } else if (frame.type === "task_resume") {
          for (const event of tasks.eventsAfter(
            frame.taskId,
            frame.afterCursor,
          ))
            send(socket, { type: "task_event", event });
          sendState(socket, frame.taskId);
        } else if (frame.type === "task_status") {
          sendState(socket, frame.taskId);
        }
      } catch (error) {
        socket.send(
          encodeFrame({
            type: "error",
            error: {
              code: "INVALID_FRAME",
              retryable: false,
              params: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          }),
        );
      }
    });
  });

  return {
    close: async () => {
      unsubscribe();
      server.off("upgrade", upgrade);
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
