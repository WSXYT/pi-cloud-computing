import { Container, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import { safeDisplayText } from "./client-events.js";

export interface CloudQueue { steering: string[]; followUp: string[] }
export function parseCloudQueue(value: unknown): CloudQueue | undefined {
  if (!value || typeof value !== "object") return undefined;
  const queue = value as Record<string, unknown>;
  if (![queue.steering, queue.followUp].every(items => Array.isArray(items) && items.length <= 1000 && items.every(item => typeof item === "string"))) return undefined;
  return { steering: queue.steering as string[], followUp: queue.followUp as string[] };
}

/** Same components as Pi's pending-message area; these are queues, not transcript/log rows. */
export function cloudQueueComponent(queue: CloudQueue, dim: (text: string) => string, labels: { steer: string; followUp: string; disconnected?: string }): Container {
  const container = new Container();
  if (!queue.steering.length && !queue.followUp.length) return container;
  container.addChild(new Spacer(1));
  if (labels.disconnected) container.addChild(new TruncatedText(dim(labels.disconnected), 1, 0));
  for (const message of queue.steering) container.addChild(new TruncatedText(dim(`${labels.steer}: ${safeDisplayText(message)}`), 1, 0));
  for (const message of queue.followUp) container.addChild(new TruncatedText(dim(`${labels.followUp}: ${safeDisplayText(message)}`), 1, 0));
  return container;
}
