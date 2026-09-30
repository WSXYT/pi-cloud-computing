import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "leaf") {
  process.stdout.write("tree-ready\n");
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "leaf"], { stdio: "inherit" });
}
setInterval(() => {}, 1000);
