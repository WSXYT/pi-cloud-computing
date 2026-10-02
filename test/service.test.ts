import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupExpiredTasks,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsWorkerScript,
  renderWindowsTask,
  WINDOWS_WORKER_TASK,
  WORKER_SERVICE_LABEL,
} from "../src/worker/service.js";

test("renders a hardened systemd worker unit", () => {
  const unit = renderSystemdUnit({
    dataDir: "/srv/pi-cloud",
    executable: "/usr/bin/node",
    cliPath: "/opt/pi-cloud/dist/cli.js",
  });
  assert.match(unit, /^User=[A-Za-z0-9_.-]+$/m, "systemd User= does not accept shell-quoted account names");
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /PI_CLOUD_DATA_DIR=\/srv\/pi-cloud/);
});

test("renders native macOS and Windows Worker services", () => {
  const plist = renderLaunchdPlist({ dataDir: "/Users/me/.pi-cloud", executable: "/usr/local/bin/node", cliPath: "/opt/pi-cloud/dist/cli.js", label: WORKER_SERVICE_LABEL });
  assert.match(plist, new RegExp(`<key>Label</key><string>${WORKER_SERVICE_LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /worker<\/string>/);
  assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/, "user-triggered task startup must not inherit launchd background I/O throttling");
  const script = renderWindowsWorkerScript({ dataDir: "C:\\Users\\me\\.pi-cloud", executable: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\pi-cloud\\dist\\cli.js" });
  assert.match(script, /PI_CLOUD_DATA_DIR=C:\\Users\\me\\\.pi-cloud/);
  assert.match(script, /worker serve/);
  assert.equal(WINDOWS_WORKER_TASK, "PiCloudWorker");
  const task = renderWindowsTask("C:\\Users\\me\\.pi-cloud");
  assert.match(task, /service-entry\.js/);
  assert.doesNotMatch(task, /cmd\.exe/);
  assert.match(task, /<LogonType>S4U<\/LogonType>/);
  assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(task, /<BootTrigger>/);
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
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
