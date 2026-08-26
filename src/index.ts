export { PROTOCOL_VERSION } from "./version.js";
export * from "./client-network.js";
export * from "./client-state.js";
export * from "./result.js";
export * from "./environment.js";
export * from "./git.js";
export * from "./errors.js";
export * from "./i18n.js";
export * from "./protocol.js";
export * from "./session.js";
export * from "./worker/execution.js";
export * from "./worker/network.js";
export * from "./worker/pairing.js";
export * from "./worker/rpc.js";
export * from "./worker/runner.js";
export * from "./worker/secrets.js";
export * from "./worker/service.js";
export * from "./worker/server.js";
export * from "./worker/task-store.js";
export * from "./worker/tasks.js";
export * from "./worker/tls.js";
export * from "./worker/ws.js";

export const RECOMMENDATION_PLACEHOLDERS = {
  sponsor: { id: "sponsor-placeholder", enabled: false },
  relay: { id: "relay-recommendation-placeholder", enabled: false },
} as const;
