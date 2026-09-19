import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import {
  encodeFrame,
  parseFrame,
  type ClientFrame,
  type TaskUiResponse,
  type WorkerIdentity,
  type ProtocolFrame,
} from "../protocol.js";
import { PROTOCOL_VERSION } from "../version.js";
import { PiCloudError } from "../errors.js";
import { authenticateToken } from "./pairing.js";
import type { WorkerState } from "./state.js";
import type { WorkerTaskManager } from "./tasks.js";

export interface TaskSocket {
  close(): Promise<void>;
}

export function attachTaskWebSocket(
  server: HttpServer,
  state: WorkerState,
  identity: WorkerIdentity,
  tasks: WorkerTaskManager,
  options: {
    getState?: () => Promise<WorkerState>;
    flush?: () => Promise<void>;
    acceptsInput?: (taskId: string) => boolean;
    answerUi?: (response: TaskUiResponse) => void;
    deferAbort?: boolean;
    enforceRunner?: boolean;
  } = {},
): TaskSocket {
  const sockets = new Map<
    WebSocket,
    { token: string; tasks: Set<string>; replaying: Set<string> }
  >();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 50 * 1024 * 1024,
  });
  const currentState = () =>
    options.getState ? options.getState() : Promise.resolve(state);
  const authorized = async (socket: WebSocket): Promise<boolean> => {
    const client = sockets.get(socket);
    if (client && authenticateToken(await currentState(), client.token))
      return true;
    socket.close(4003, "AUTH_REJECTED");
    return false;
  };
  const send = (socket: WebSocket, frame: ProtocolFrame): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 5 * 1024 * 1024) {
      socket.close(1013, "resume with an event cursor");
      return;
    }
    socket.send(encodeFrame(frame));
  };
  const sendState = (socket: WebSocket, taskId: string): void => {
    const snapshot = tasks.snapshot(taskId);
    send(socket, { type: "task_state", state: snapshot });
    if (snapshot.result && !snapshot.finalizing)
      send(socket, { type: "task_result", result: snapshot.result });
  };
  let broadcasts = Promise.resolve();
  const unsubscribe = tasks.subscribe((event) => {
    broadcasts = broadcasts
      .then(async () => {
        await options.flush?.();
        const auth = await currentState();
        for (const [socket, client] of sockets) {
          if (!authenticateToken(auth, client.token)) {
            socket.close(4003, "AUTH_REJECTED");
            continue;
          }
          if (
            !client.tasks.has(event.taskId) ||
            client.replaying.has(event.taskId)
          )
            continue;
          send(socket, { type: "task_event", event });
          if (
            event.kind === "status" &&
            ["completed", "failed", "aborted"].includes(
              String(event.payload.status),
            ) && event.cursor === tasks.snapshot(event.taskId).cursor
          )
            sendState(socket, event.taskId);
        }
      })
      .catch(() => {
        // Don't acknowledge or stream state which failed durable persistence/auth validation.
        for (const socket of sockets.keys())
          socket.close(1011, "Worker state unavailable");
      });
  });
  const revocationCheck = setInterval(() => {
    for (const socket of sockets.keys())
      void authorized(socket).catch(() =>
        socket.close(1011, "Worker state unavailable"),
      );
  }, 1_000);
  revocationCheck.unref();

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = URL.parse(request.url ?? "/", "https://worker.invalid");
      const header = request.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
      if (url?.pathname !== "/events") {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (!authenticateToken(await currentState(), token)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        sockets.set(client, { token, tasks: new Set(), replaying: new Set() });
        wss.emit("connection", client);
      });
    })().catch(() => socket.destroy());
  };
  server.on("upgrade", upgrade);
  wss.on("connection", (socket) => {
    const client = sockets.get(socket)!;
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let messages = Promise.resolve();
    socket.on("message", (raw) => {
      messages = messages.then(async () => {
        let requestType: ClientFrame["type"] | undefined;
        try {
          if (!(await authorized(socket))) return;
          const frame = parseFrame(raw.toString());
          if (frame.type === "hello") {
            send(socket, {
              type: "hello_ack",
              protocolVersion: PROTOCOL_VERSION,
              worker: identity,
            });
          } else if (frame.type === "task_create") {
            requestType = frame.type;
            if (
              options.enforceRunner &&
              !identity.capabilities.runners.includes(frame.task.runner)
            )
              throw new Error("requested runner is not enabled on this Worker");
            client.tasks.add(frame.task.taskId);
            const record = tasks.create(frame.task);
            await options.flush?.();
            send(socket, {
              type: "task_accepted",
              taskId: record.task.taskId,
              status: record.status,
            });
            sendState(socket, record.task.taskId);
          } else if (frame.type === "task_input") {
            requestType = frame.type;
            client.tasks.add(frame.input.taskId);
            const duplicate =
              frame.input.id &&
              tasks
                .get(frame.input.taskId)
                ?.inputs.some((item) => item.id === frame.input.id);
            if (
              !duplicate &&
              options.acceptsInput &&
              !options.acceptsInput(frame.input.taskId)
            )
              throw new Error("task is settling; input was not delivered");
            const record = tasks.input(frame.input);
            await options.flush?.();
            if (frame.input.id)
              send(socket, {
                type: "task_input_accepted",
                taskId: record.task.taskId,
                inputId: frame.input.id,
              });
            else
              send(socket, {
                type: "task_accepted",
                taskId: record.task.taskId,
                status: record.status,
              });
          } else if (frame.type === "task_ui_response") {
            requestType = frame.type;
            if (!options.answerUi) throw new Error("remote UI is unavailable");
            tasks.answerUi(frame.response);
            options.answerUi(frame.response);
            await options.flush?.();
          } else if (frame.type === "task_abort") {
            requestType = frame.type;
            client.tasks.add(frame.taskId);
            const record = tasks.abort(frame.taskId, options.deferAbort);
            await options.flush?.();
            send(socket, {
              type: "task_accepted",
              taskId: record.task.taskId,
              status: record.status,
            });
          } else if (frame.type === "task_resume") {
            requestType = frame.type;
            client.tasks.add(frame.taskId);
            client.replaying.add(frame.taskId);
            try {
              let cursor = frame.afterCursor;
              while (socket.readyState === WebSocket.OPEN) {
                await options.flush?.();
                const events = tasks.eventsAfter(frame.taskId, cursor);
                if (!events.length) break;
                for (const event of events) {
                  if (!(await authorized(socket))) return;
                  await new Promise<void>((resolve, reject) =>
                    socket.send(
                      encodeFrame({ type: "task_event", event }),
                      (error) => (error ? reject(error) : resolve()),
                    ),
                  );
                  cursor = event.cursor;
                }
              }
              sendState(socket, frame.taskId);
            } finally {
              client.replaying.delete(frame.taskId);
            }
          } else if (frame.type === "task_status") {
            requestType = frame.type;
            client.tasks.add(frame.taskId);
            await options.flush?.();
            sendState(socket, frame.taskId);
          } else throw new Error("unsupported client frame");
        } catch (error) {
          send(socket, {
            type: "error",
            ...(requestType ? { requestType } : {}),
            error: error instanceof PiCloudError ? error.toProtocol() : {
              code: error instanceof Error && error.message === "task not found" ? "TASK_NOT_FOUND" : "INVALID_FRAME",
              retryable: false,
            },
          });
        }
      });
      void messages.catch(() => socket.close(1011, "Worker request failed"));
    });
  });
  return {
    close: async () => {
      unsubscribe();
      clearInterval(revocationCheck);
      server.off("upgrade", upgrade);
      for (const socket of sockets.keys()) socket.terminate();
      await broadcasts;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
