import assert from "node:assert/strict";
import test from "node:test";
import { TruncatedText, visibleWidth } from "@earendil-works/pi-tui";
import { cloudQueueComponent, parseCloudQueue } from "../src/client-queue.js";

test("cloud queue uses Pi pending-row components and keeps delivery classes separate", () => {
  const queue = parseCloudQueue({ steering: ["中文 steer"], followUp: ["next turn\x1b]52;c;secret\x07"], type: "queue_update" });
  assert.ok(queue);
  const component = cloudQueueComponent(queue, text => text, { steer: "Steering", followUp: "Follow-up", disconnected: "Last confirmed queue" });
  assert.ok(component.children.slice(1).every(child => child instanceof TruncatedText));
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /Steering: 中文 steer/); assert.match(rendered, /Follow-up: next turn/);
  assert.ok(!rendered.includes("\x1b]52"));
  assert.ok(component.render(30).every(line => visibleWidth(line) <= 30));
  assert.equal(parseCloudQueue({ steering: [null], followUp: [] }), undefined);
  assert.equal(parseCloudQueue({ steering: [], followUp: "not a queue" }), undefined);
  assert.equal(cloudQueueComponent({ steering: [], followUp: [] }, text => text, { steer: "s", followUp: "f" }).children.length, 0);
});
