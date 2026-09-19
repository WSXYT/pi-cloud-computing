import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../environment.js";
import type { ArtifactDescriptor } from "../protocol.js";
import { validateIdentifier } from "../paths.js";

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
    validateIdentifier(id);
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
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.describe(id);
        if (existing.sha256 !== descriptor.sha256)
          throw new Error("artifact id already exists with different content");
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return descriptor;
  }

  async describe(id: string): Promise<ArtifactDescriptor> {
    const content = await this.read(id);
    return {
      id,
      kind: "result",
      size: content.byteLength,
      sha256: sha256(content),
      contentType: "application/octet-stream",
    };
  }

  async read(id: string): Promise<Buffer> {
    validateIdentifier(id);
    const path = join(this.root, id);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_ARTIFACT_BYTES
    )
      throw new Error("invalid artifact file or size");
    return readFile(path);
  }

  async readVerified(descriptor: ArtifactDescriptor): Promise<Buffer> {
    const bytes = await this.read(descriptor.id);
    if (bytes.length !== descriptor.size || sha256(bytes) !== descriptor.sha256)
      throw new Error("ARTIFACT_HASH_MISMATCH");
    return bytes;
  }

  stream(id: string): NodeJS.ReadableStream {
    validateIdentifier(id);
    return createReadStream(join(this.root, id));
  }
}
