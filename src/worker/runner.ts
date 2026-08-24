import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";

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

export function dockerArgs(
  image: string,
  cwd: string,
  command: string,
  args: string[],
): string[] {
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
    ...args,
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
    return spawn(
      "docker",
      dockerArgs(this.image, options.cwd.toString(), command, args),
      {
        ...options,
        cwd: undefined,
        stdio: "pipe",
      },
    );
  }
}

export function createExecutionRunner(
  mode: "docker" | "host",
): ExecutionRunner {
  return mode === "docker" ? new DockerRunner() : new HostRunner();
}
