import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/client.js";

test("registers the cloud command surface", async () => {
  const commands: string[] = [];
  const fake = {
    registerCommand(name: string) {
      commands.push(name);
    },
    on() {},
  } as unknown as ExtensionAPI;
  await extension(fake);
  assert.deepEqual(commands, [
    "cloud-pair",
    "cloud-unpair",
    "cloud-abort",
    "cloud-submit",
    "cloud-reconnect",
    "cloud-apply",
    "cloud-merge",
    "cloud-sponsor",
    "cloud",
  ]);
});
