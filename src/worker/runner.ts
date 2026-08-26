import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";

export interface ExecutionRunner {
  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
}

export class HostRunner implements ExecutionRunner {
  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams {
    return spawn(command, args, { ...options, stdio: "pipe" });
  }
}

function containerPath(cwd: string, value: string): string {
  if (!isAbsolute(value)) return value;
  const path = relative(cwd, value);
  if (path.startsWith("..") || isAbsolute(path)) return value;
  return path ? `/workspace/${path.split(sep).join("/")}` : "/workspace";
}

export function dockerArgs(
  image: string,
  cwd: string,
  command: string,
  args: string[],
): string[] {
  const containerArgs = args.map((arg) => containerPath(cwd, arg));
  return [
    "run",
    "--rm",
    "-i",
    "--network=none",
    "--read-only",
    "-v",
    `${cwd}:/workspace`,
    "-w",
    "/workspace",
    image,
    command,
    ...containerArgs,
  ];
}

export class DockerRunner implements ExecutionRunner {
  constructor(private readonly image = "pi-cloud-worker:latest") {}

  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams {
    if (!options.cwd) throw new Error("Docker runner requires a workspace cwd");
    const cwd = options.cwd.toString();
    const env = { ...options.env };
    if (env.PI_CODING_AGENT_DIR)
      env.PI_CODING_AGENT_DIR = containerPath(cwd, env.PI_CODING_AGENT_DIR);
    return spawn("docker", dockerArgs(this.image, cwd, command, args), {
      ...options,
      cwd: undefined,
      env,
      stdio: "pipe",
    });
  }
}

export function createExecutionRunner(
  mode: "docker" | "host",
): ExecutionRunner {
  return mode === "docker" ? new DockerRunner() : new HostRunner();
}
