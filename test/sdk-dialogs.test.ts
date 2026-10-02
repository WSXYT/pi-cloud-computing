import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SdkDialogs } from "../src/worker/sdk-dialogs.js";

test("SDK standard dialogs preserve empty/multiline values, reject invalid selections and scope concurrent replies", async () => {
  const events: Record<string, unknown>[] = [];
  const host = new SdkDialogs(event => events.push(event));
  const confirm = host.ask({ method: "confirm", title: "Consent", message: "Allow?" });
  const select = host.ask({ method: "select", title: "Choice", options: ["one", "two"] });
  const input = host.ask({ method: "input", title: "Input" });
  const editor = host.ask({ method: "editor", title: "Editor", prefill: "original" });
  const ids = events.map(event => String(event.id));
  host.answer({ id: ids[1]!, value: "not an offered option" });
  assert.equal(events.length, 4);
  host.answer({ id: ids[2]!, value: "" });
  host.answer({ id: ids[0]!, confirmed: false });
  host.answer({ id: ids[3]!, value: "line 1\n中文\n" });
  host.answer({ id: ids[1]!, value: "two" });
  assert.deepEqual(await Promise.all([confirm, select, input, editor]), [false, "two", "", "line 1\n中文\n"]);
  assert.equal(events.filter(event => event.type === "extension_ui_closed").length, 4);
  host.close();
});

test("SDK dialog timeout, abort and shutdown never accept a late approval", async () => {
  const events: Record<string, unknown>[] = [];
  const host = new SdkDialogs(event => events.push(event));
  const timed = host.ask({ method: "confirm", title: "Expiring" }, { timeout: 10 });
  const timedId = String(events[0]?.id);
  await delay(20);
  assert.equal(await timed, false);
  host.answer({ id: timedId, confirmed: true });
  const controller = new AbortController();
  const aborted = host.ask({ method: "input", title: "Abort" }, { signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, undefined);
  const pending = host.ask({ method: "confirm", title: "Shutdown" });
  host.close();
  assert.equal(await pending, false);
  assert.equal(await host.ask({ method: "confirm", title: "Closed" }), false);
  assert.equal(events.filter(event => event.type === "extension_ui_closed").length, 3);
});
