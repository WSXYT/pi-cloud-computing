import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { SdkComponentHost, safeComponentLine, type ComponentFrame } from "../src/worker/sdk-components.js";

const flush = () => delay(0);
const openId = (frames: ComponentFrame[]) => {
  const open = frames.findLast(frame => frame.type === "open");
  assert.ok(open); return open.id;
};

test("component host serializes focus and keeps original callback results inside the task", async () => {
  const frames: ComponentFrame[] = [];
  const host = new SdkComponentHost(frame => frames.push(frame), truncateToWidth);
  const result = { closure: new Set(["not JSON"]), fn: () => "not transferred" };
  let disposed = 0, secondInputs = 0;
  const first = host.custom(done => ({
    render: () => ["\x1b[31mNative colored component\x1b[0m\x1b]52;c;CLIPBOARD\x07"],
    invalidate() {}, dispose() { disposed++; }, handleInput: () => done(result),
  }));
  const second = host.custom(done => ({
    render: width => ["x".repeat(width + 50)], invalidate() {}, dispose() { disposed++; },
    handleInput() { secondInputs++; done("second"); },
  }));
  await flush();
  const firstId = openId(frames);
  assert.equal(frames.filter(frame => frame.type === "open").length, 1);
  const rendered = frames.find(frame => frame.type === "frame");
  assert.ok(rendered?.type === "frame");
  assert.match(rendered.lines.join(""), /\x1b\[31m/);
  assert.doesNotMatch(rendered.lines.join(""), /CLIPBOARD|\]52/);
  host.input(firstId, "\r");
  assert.equal(await first, result);
  await flush();
  const secondId = openId(frames);
  assert.notEqual(secondId, firstId);
  host.input(firstId, "stale key");
  host.input(secondId, "x".repeat(65537));
  assert.equal(secondInputs, 0);
  host.resize(secondId, 30);
  await delay(70);
  const resized = frames.findLast(frame => frame.type === "frame");
  assert.ok(resized?.type === "frame");
  assert.equal(resized.width, 30);
  assert.ok(resized.lines.every(line => visibleWidth(line) <= 30));
  host.input(secondId, "\r");
  assert.equal(await second, "second");
  assert.equal(disposed, 2);
  host.close(); host.close();
});

test("cancel during an async component factory never publishes a late frame or approves the request", async () => {
  const frames: ComponentFrame[] = [];
  const host = new SdkComponentHost(frame => frames.push(frame), truncateToWidth);
  const gate = Promise.withResolvers<Component & { dispose(): void }>();
  let disposed = 0;
  const pending = host.custom(() => gate.promise);
  const rejected = assert.rejects(pending, /CLOUD_UI_CANCELLED/);
  await flush();
  host.cancel(openId(frames));
  await rejected;
  gate.resolve({ render: () => ["LATE FRAME"], invalidate() {}, dispose() { disposed++; } });
  await flush();
  assert.equal(disposed, 1);
  assert.equal(frames.filter(frame => frame.type === "frame").length, 0);
  host.close();
  await assert.rejects(host.custom(() => ({ render: () => [], invalidate() {} })), /CLOUD_UI_CLOSED/);
});

test("oversized components and transport loss fail closed, not as a fabricated plugin result", async () => {
  assert.equal(safeComponentLine("safe\x1b[2J\x1b]0;window title\x07\r\ntext"), "safetext");
  const host = new SdkComponentHost(() => {}, truncateToWidth);
  await assert.rejects(host.custom(() => ({ render: () => Array(501).fill("row"), invalidate() {} })), /CLOUD_UI_RENDER_FAILED/);
  const pending = host.custom(() => ({ render: () => ["waiting"], invalidate() {} }));
  const queued = host.custom(() => ({ render: () => ["never approved"], invalidate() {} }));
  const rejected = Promise.all([assert.rejects(pending, /CLOUD_UI_CLOSED/), assert.rejects(queued, /CLOUD_UI_CLOSED/)]);
  await flush(); host.close(); await rejected;
});
