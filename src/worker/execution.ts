import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../environment.js";
import {
  materializeCredentials,
  materializeEnvironment,
  parseEnvironmentArchive,
  type EnvironmentArchive,
} from "../environment-archive.js";
import {
  createGitResultSnapshot,
  materializeWorkspaceArchive,
  parseWorkspaceArchive,
  serializeGitSnapshot,
  type GitSnapshot,
} from "../git.js";
import { validateIdentifier } from "../paths.js";
import {
  parseSessionArchive,
  serializeSessionArchive,
  type SessionArchive,
} from "../session.js";
import type { ArtifactStore } from "./artifacts.js";
import type { SecretStore } from "./secrets.js";
import type { TaskRecord } from "./tasks.js";

export interface PreparedTask {
  workspace: string;
  runtimeDir: string;
  runtimeAgentDir: string;
  sessionPath: string;
  uploaded: GitSnapshot;
  env: NodeJS.ProcessEnv;
}

export async function prepareTask(
  dataDir: string,
  artifacts: ArtifactStore,
  secrets: SecretStore,
  record: TaskRecord,
): Promise<PreparedTask> {
  validateIdentifier(record.task.taskId);
  const taskDir = join(dataDir, "tasks", record.task.taskId);
  const workspace = join(taskDir, "workspace");
  const runtimeDir = join(taskDir, "runtime");
  const runtimeAgentDir = join(runtimeDir, "agent");
  const sessionPath = join(taskDir, "session.jsonl");
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  try {
    const workspaceArtifact = record.task.artifacts.find(
      (artifact) => artifact.kind === "workspace",
    );
    if (!workspaceArtifact) throw new Error("workspace artifact is required");
    const archive = parseWorkspaceArchive(
      (await artifacts.readVerified(workspaceArtifact)).toString("utf8"),
    );
    for (const key of [
      "repositoryHash",
      "head",
      "indexHash",
      "worktreeHash",
    ] as const)
      if (archive.snapshot.baseline[key] !== record.task.git[key])
        throw new Error("workspace does not match task baseline");
    await materializeWorkspaceArchive(archive, workspace);
    await mkdir(runtimeAgentDir, { recursive: true, mode: 0o700 });
    await mkdir(join(runtimeDir, "home"), { recursive: true, mode: 0o700 });
    let environment: EnvironmentArchive | undefined;
    const environmentArtifact = record.task.artifacts.find(
      (artifact) => artifact.kind === "environment",
    );
    if (environmentArtifact) {
      environment = parseEnvironmentArchive(
        (await artifacts.readVerified(environmentArtifact)).toString("utf8"),
      );
      await materializeEnvironment(environment, runtimeAgentDir);
    }
    const sessionArtifact = record.task.artifacts.find(
      (artifact) => artifact.kind === "session",
    );
    const session: SessionArchive = sessionArtifact
      ? parseSessionArchive(
          (await artifacts.readVerified(sessionArtifact)).toString("utf8"),
        )
      : {
          header: {
            type: "session",
            version: 3,
            id: record.task.session.sessionId,
            timestamp: new Date().toISOString(),
            cwd: workspace,
          },
          entries: [],
          leafId: null,
          entriesSha256: sha256(""),
        };
    if (
      session.header.id !== record.task.session.sessionId ||
      session.entriesSha256 !== record.task.session.entriesSha256 ||
      session.leafId !== record.task.session.baseLeafId ||
      session.leafId !== record.task.session.lastEntryId
    )
      throw new Error("session artifact does not match task cursor");
    await writeFile(
      sessionPath,
      serializeSessionArchive({
        ...session,
        header: { ...session.header, cwd: workspace },
      }),
      { mode: 0o600, flag: "wx" },
    );
    // Credentials are the last materialization step, and every failure removes plaintext.
    let credentialEnv: Record<string, string> = {};
    const runtimeSecretId = record.task.secretIds.find((id) => id === "pi-runtime" || /^pi-runtime-[a-f0-9]{64}$/.test(id));
    if (record.task.secretIds.some((id) => id !== "pi-auth" && id !== runtimeSecretId)) throw new Error("unsupported authorized credential bundle");
    if (runtimeSecretId) {
      const fingerprint = record.task.environment.secretVersions.find((secret) => secret.id === runtimeSecretId);
      if (!fingerprint || fingerprint.authorized !== true || !Number.isSafeInteger(fingerprint.version) || fingerprint.version < 1) throw new Error("SECRET_NOT_AUTHORIZED");
      const value = await secrets.get(runtimeSecretId, fingerprint.version);
      if (!value) throw new Error("authorized Pi runtime credentials are missing or revoked");
      if (fingerprint.sha256 !== sha256(value)) throw new Error("credential authorization fingerprint mismatch");
      credentialEnv = await materializeCredentials(
        value,
        runtimeAgentDir,
        environment,
      );
    }
    if (record.task.secretIds.includes("pi-auth")) {
      const auth = await secrets.get("pi-auth");
      if (!auth) throw new Error("authorized Pi credentials are missing");
      await writeFile(join(runtimeAgentDir, "auth.json"), auth, {
        mode: 0o600,
      });
    }
    const bootstrapPath = join(runtimeDir, "bootstrap.mjs");
    await copyFile(new URL("./bootstrap.js", import.meta.url), bootstrapPath);
    await writeFile(
      join(runtimeDir, "bootstrap.json"),
      JSON.stringify(environment?.installPaths ?? []),
      { mode: 0o600 },
    );
    return {
      workspace,
      runtimeDir,
      runtimeAgentDir,
      sessionPath,
      uploaded: archive.snapshot,
      env: {
        ...credentialEnv,
        HOME: join(runtimeDir, "home"),
        USERPROFILE: join(runtimeDir, "home"),
        PI_CODING_AGENT_DIR: runtimeAgentDir,
        PI_CLOUD_TASK_DIR: taskDir,
        PI_CLOUD_BOOTSTRAP: bootstrapPath,
      },
    };
  } catch (error) {
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupPreparedTask(
  prepared: PreparedTask,
): Promise<void> {
  await rm(prepared.runtimeDir, { recursive: true, force: true });
}

export async function cleanupInterruptedRuntime(
  dataDir: string,
  taskId: string,
): Promise<void> {
  validateIdentifier(taskId);
  await rm(join(dataDir, "tasks", taskId, "runtime"), {
    recursive: true,
    force: true,
  });
  // Remove plaintext left by versions that placed auth inside the workspace.
  await rm(join(dataDir, "tasks", taskId, "workspace", ".pi-cloud-agent"), {
    recursive: true,
    force: true,
  });
}

export async function collectTaskResults(
  artifacts: ArtifactStore,
  record: TaskRecord,
  prepared: PreparedTask,
): Promise<Record<string, unknown>> {
  const result = await createGitResultSnapshot(
    prepared.workspace,
    record.task.git,
    prepared.uploaded,
  );
  const resultArtifactId = `${record.task.taskId}-result-git.json`;
  await artifacts.put(
    resultArtifactId,
    Buffer.from(serializeGitSnapshot(result)),
    "application/json",
  );
  const sessionArtifactId = `${record.task.taskId}-result-session.jsonl`;
  const session = await readFile(prepared.sessionPath);
  // Never publish malformed native-session output as a usable result.
  parseSessionArchive(session.toString("utf8"));
  await artifacts.put(sessionArtifactId, session, "application/jsonl");
  return {
    resultArtifactId,
    sessionArtifactId,
    changedFiles: result.files.length,
  };
}
