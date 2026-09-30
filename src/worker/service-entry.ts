import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { runWorkerCli } from "./cli.js";
import { ensurePrivateDirectory } from "../storage.js";

// Task Scheduler must own Node itself, not a cmd.exe parent that can leave Node orphaned.
const dataDir = process.argv[2];
if (!dataDir) throw new Error("Worker service data directory is required");
process.env.PI_CLOUD_DATA_DIR = dataDir;
await ensurePrivateDirectory(dataDir);
const log = (line: string): void => appendFileSync(join(dataDir, "worker.log"), `${line}\n`, { mode: 0o600 });
try {
  process.exitCode = await runWorkerCli(["worker", "serve"], log);
} catch {
  log("Worker service failed; run worker health and inspect configuration.");
  process.exitCode = 1;
}
