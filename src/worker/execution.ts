import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createGitResultSnapshot,
  materializeWorkspaceArchive,
  parseWorkspaceArchive,
  serializeGitSnapshot,
} from "../git.js";
import { parseSessionArchive, serializeSessionArchive } from "../session.js";
import type { ArtifactStore } from "./artifacts.js";
import type { SecretStore } from "./secrets.js";
import type { TaskRecord } from "./tasks.js";

export interface PreparedTask {
  workspace: string;
  runtimeAgentDir?: string;
  sessionPath?: string;
}

export async function prepareTask(
  dataDir: string,
  artifacts: ArtifactStore,
  secrets: SecretStore,
  record: TaskRecord,
): Promise<PreparedTask> {
  const taskDir = join(dataDir, "tasks", record.task.taskId);
  const workspace = join(taskDir, "workspace");
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  const workspaceArtifact = record.task.artifacts.find((artifact) => artifact.kind === "workspace");
  if (!workspaceArtifact) throw new Error("workspace artifact is required");
  const archive = parseWorkspaceArchive((await artifacts.read(workspaceArtifact.id)).toString("utf8"));
  await materializeWorkspaceArchive(archive, workspace);

  let runtimeAgentDir: string | undefined;
  if (record.task.secretIds.includes("pi-auth")) {
    const auth = await secrets.get("pi-auth");
    if (!auth) throw new Error("authorized Pi credentials are missing");
    runtimeAgentDir = join(workspace, ".pi-cloud-agent");
    await mkdir(runtimeAgentDir, { recursive: true, mode: 0o700 });
    await writeFile(join(runtimeAgentDir, "auth.json"), auth, { mode: 0o600 });
  }

  const sessionArtifact = record.task.artifacts.find((artifact) => artifact.kind === "session");
  if (!sessionArtifact) return { workspace, ...(runtimeAgentDir ? { runtimeAgentDir } : {}) };
  const session = parseSessionArchive((await artifacts.read(sessionArtifact.id)).toString("utf8"));
  const sessionPath = join(workspace, ".pi-cloud-session.jsonl");
  await writeFile(
    sessionPath,
    serializeSessionArchive({ ...session, header: { ...session.header, cwd: workspace } }),
    { mode: 0o600 },
  );
  return { workspace, sessionPath, ...(runtimeAgentDir ? { runtimeAgentDir } : {}) };
}

export async function cleanupPreparedTask(prepared: PreparedTask): Promise<void> {
  if (prepared.runtimeAgentDir) await rm(prepared.runtimeAgentDir, { recursive: true, force: true });
}

export async function collectTaskResults(
  artifacts: ArtifactStore,
  record: TaskRecord,
  prepared: PreparedTask,
): Promise<Record<string, unknown>> {
  const result = await createGitResultSnapshot(prepared.workspace, record.task.git);
  const resultArtifactId = `${record.task.taskId}-result-git.json`;
  await artifacts.put(resultArtifactId, Buffer.from(serializeGitSnapshot(result)), "application/json");
  const payload: Record<string, unknown> = { resultArtifactId, changedFiles: result.files.length };
  if (prepared.sessionPath) {
    const sessionArtifactId = `${record.task.taskId}-result-session.jsonl`;
    await artifacts.put(sessionArtifactId, await readFile(prepared.sessionPath), "application/jsonl");
    payload.sessionArtifactId = sessionArtifactId;
  }
  return payload;
}
