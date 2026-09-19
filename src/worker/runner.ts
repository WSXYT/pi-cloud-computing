import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

export interface ExecutionRunner {
  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
  terminate?(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void;
}

export class HostRunner implements ExecutionRunner {
  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams {
    return spawn(command, args, {
      ...options,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
  }
  terminate(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          child.emit("error", error);
      }
    } else child.kill(signal);
  }
}

function containerPath(root: string, value: string): string {
  if (!isAbsolute(value)) return value;
  const path = relative(root, value);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    return value;
  return path ? `/task/${path.split(sep).join("/")}` : "/task";
}

export function dockerArgs(
  image: string,
  cwd: string,
  command: string,
  args: string[],
  options: {
    network?: "none" | "bridge";
    root?: string;
    envKeys?: string[];
    name?: string;
  } = {},
): string[] {
  const root = options.root ?? cwd;
  return [
    "run",
    "--rm",
    "-i",
    "--init",
    `--network=${options.network ?? "none"}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
    ...(typeof process.getuid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid!()}`]
      : []),
    ...(options.name ? ["--name", options.name] : []),
    "--label",
    "pi-cloud-task=true",
    "-v",
    `${root}:/task`,
    "-w",
    containerPath(root, cwd),
    ...(options.envKeys ?? []).flatMap((key) => ["--env", key]),
    image,
    command,
    ...args.map((arg) => containerPath(root, arg)),
  ];
}

export class DockerRunner implements ExecutionRunner {
  private readonly containers = new WeakMap<
    ChildProcessWithoutNullStreams,
    string
  >();
  constructor(
    private readonly image = "pi-cloud-worker:latest",
    private readonly network: "none" | "bridge" = "none",
  ) {}

  spawn(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams {
    if (!options.cwd) throw new Error("Docker runner requires a workspace cwd");
    const cwd = options.cwd.toString();
    const root = options.env?.PI_CLOUD_TASK_DIR ?? cwd;
    const env = { ...options.env };
    for (const key of [
      "PI_CODING_AGENT_DIR",
      "PI_CLOUD_TASK_DIR",
      "PI_CLOUD_BOOTSTRAP",
      "HOME",
      "USERPROFILE",
    ])
      if (env[key]) env[key] = containerPath(root, env[key]!);
    const name = `pi-cloud-${randomUUID()}`;
    const envKeys = Object.keys(env).filter(
      (key) =>
        !/^(?:path|systemroot|windir|comspec|pathext|tmp|temp|tmpdir)$/i.test(
          key,
        ),
    );
    // --env NAME reads the value from the Docker CLI environment, never from argv.
    const child = spawn(
      "docker",
      dockerArgs(this.image, cwd, command, args, {
        root,
        envKeys,
        name,
        network: this.network,
      }),
      {
        ...options,
        cwd: undefined,
        env,
        stdio: "pipe",
      },
    );
    this.containers.set(child, name);
    return child;
  }

  terminate(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    const name = this.containers.get(child);
    if (!name) {
      child.kill(signal);
      return;
    }
    execFile(
      "docker",
      ["kill", `--signal=${signal}`, name],
      { timeout: 15_000, windowsHide: true },
      (error) => {
        if (error && child.exitCode === null && child.signalCode === null) {
          child.emit(
            "error",
            new Error(
              `Could not confirm Docker container termination: ${name}`,
            ),
          );
          child.kill("SIGKILL");
        }
      },
    );
  }
}

export function createExecutionRunner(
  mode: "docker" | "host",
  network: "none" | "bridge" = "none",
): ExecutionRunner {
  return mode === "docker"
    ? new DockerRunner(undefined, network)
    : new HostRunner();
}
