// Copied into a task's runtime directory and executed inside its selected runner.
// Only Node built-ins: no code from an uploaded package executes in the Worker process.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let child: ChildProcess | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => child?.kill(signal));

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: [command === "pi" ? "inherit" : "ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

try {
  const runtime = dirname(fileURLToPath(import.meta.url));
  const agentDir = join(runtime, "agent");
  const configuration: unknown = JSON.parse(
    await readFile(join(runtime, "bootstrap.json"), "utf8"),
  );
  if (
    !Array.isArray(configuration) ||
    configuration.some((path) => typeof path !== "string")
  )
    throw new Error("invalid runtime dependency manifest");
  for (const path of configuration as string[]) {
    const directory = resolve(agentDir, path);
    const inside = relative(agentDir, directory);
    if (inside.startsWith("..") || isAbsolute(inside))
      throw new Error("invalid runtime dependency path");
    // Pi installs registry/Git packages itself; only uploaded local packages need this.
    const code = await run(
      "npm",
      ["install", "--omit=dev", "--no-audit", "--no-fund"],
      directory,
    );
    if (code !== 0)
      throw new Error(
        `runtime dependency installation failed (${code}) at ${path}`,
      );
  }
  process.exitCode = await run("pi", process.argv.slice(2), process.cwd());
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      type: "response",
      id: "pi-cloud-initial",
      command: "prompt",
      success: false,
      error:
        error instanceof Error ? error.message : "runtime bootstrap failed",
    })}\n`,
  );
  process.exitCode = 1;
}
