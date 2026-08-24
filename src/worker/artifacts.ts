import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../environment.js";
import type { ArtifactDescriptor } from "../protocol.js";

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export class ArtifactStore {
  private constructor(private readonly root: string) {}

  static async open(dataDir: string): Promise<ArtifactStore> {
    const root = join(dataDir, "artifacts");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new ArtifactStore(root);
  }

  async put(
    id: string,
    data: Uint8Array,
    contentType = "application/octet-stream",
  ): Promise<ArtifactDescriptor> {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid artifact id");
    if (data.byteLength > MAX_ARTIFACT_BYTES)
      throw new Error("artifact exceeds size limit");
    const path = join(this.root, id);
    const descriptor: ArtifactDescriptor = {
      id,
      kind: "result",
      size: data.byteLength,
      sha256: sha256(data),
      contentType,
    };
    await writeFile(path, data, { mode: 0o600, flag: "wx" }).catch(
      async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.describe(id);
        if (existing.sha256 !== descriptor.sha256)
          throw new Error("artifact id already exists with different content");
      },
    );
    return descriptor;
  }

  async describe(id: string): Promise<ArtifactDescriptor> {
    const path = join(this.root, id);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid artifact id");
    const info = await stat(path);
    if (info.size > MAX_ARTIFACT_BYTES)
      throw new Error("artifact exceeds size limit");
    const content = await readFile(path);
    return {
      id,
      kind: "result",
      size: content.byteLength,
      sha256: sha256(content),
      contentType: "application/octet-stream",
    };
  }

  async read(id: string): Promise<Buffer> {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid artifact id");
    return readFile(join(this.root, id));
  }

  stream(id: string): NodeJS.ReadableStream {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid artifact id");
    return createReadStream(join(this.root, id));
  }
}
