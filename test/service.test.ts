import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupExpiredTasks,
  renderSystemdUnit,
} from "../src/worker/service.js";

test("renders a hardened systemd worker unit", () => {
  const unit = renderSystemdUnit({
    dataDir: "/srv/pi-cloud",
    executable: "/usr/bin/node",
    cliPath: "/opt/pi-cloud/dist/cli.js",
  });
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /PI_CLOUD_DATA_DIR=\/srv\/pi-cloud/);
});

test("removes only expired task directories", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-cloud-retention-"));
  const oldTask = join(dataDir, "tasks", "old");
  const newTask = join(dataDir, "tasks", "new");
  await mkdir(oldTask, { recursive: true });
  await mkdir(newTask, { recursive: true });
  const now = Date.now();
  await utimes(
    oldTask,
    new Date(now - 3 * 24 * 60 * 60 * 1000),
    new Date(now - 3 * 24 * 60 * 60 * 1000),
  );
  assert.deepEqual(await cleanupExpiredTasks(dataDir, 2, now), ["old"]);
});
