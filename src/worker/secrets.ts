import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { sha256 } from "../environment.js";
import { validateIdentifier } from "../paths.js";
import { writePrivateFile, writePrivateJson } from "../storage.js";
import { withWorkerStateLock } from "./state.js";
import { join } from "node:path";

interface EncryptedSecret {
  id: string;
  version: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  sha256?: string;
  createdAt: string;
  revokedAt?: string;
}

interface SecretFile {
  secrets: EncryptedSecret[];
}

const ALGORITHM = "aes-256-gcm";

async function readOrCreateKey(dataDir: string): Promise<Buffer> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "master.key");
  try {
    const key = await readFile(path);
    if (key.length !== 32) throw new Error("invalid secret master key");
    await chmod(path, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    try { await writePrivateFile(path, key, true); return key; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return readOrCreateKey(dataDir);
    }
  }
}

async function readSecretFile(dataDir: string): Promise<SecretFile> {
  let text: string;
  try { text = await readFile(join(dataDir, "secrets.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { secrets: [] }; throw error; }
  try {
    const file = JSON.parse(text.replace(/^\uFEFF/, "")) as SecretFile;
    if (!file || !Array.isArray(file.secrets)) throw new Error("invalid secret file");
    for (const record of file.secrets) {
      validateIdentifier(record?.id);
      if (!Number.isSafeInteger(record.version) || record.version < 1 || typeof record.nonce !== "string" ||
          typeof record.ciphertext !== "string" || typeof record.authTag !== "string" || typeof record.createdAt !== "string" ||
          (record.revokedAt !== undefined && typeof record.revokedAt !== "string")) throw new Error("invalid secret record");
    }
    return file;
  } catch { throw new Error("invalid secret file; encrypted records were preserved"); }
}

async function writeSecretFile(
  dataDir: string,
  file: SecretFile,
): Promise<void> {
  await writePrivateJson(join(dataDir, "secrets.json"), file);
}

export interface SecretMetadata {
  id: string;
  version: number;
  sha256?: string;
  createdAt: string;
  revokedAt?: string;
}

export class SecretStore {
  private constructor(
    private readonly dataDir: string,
    private readonly key: Buffer,
  ) {}

  static async open(dataDir: string): Promise<SecretStore> {
    return new SecretStore(dataDir, await readOrCreateKey(dataDir));
  }

  async put(
    id: string,
    version: number,
    value: string,
  ): Promise<SecretMetadata> {
    validateIdentifier(id);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error("secret id and version are required");
    const digest = sha256(value);
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    cipher.setAAD(Buffer.from(`${id}\0${version}`));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const record: EncryptedSecret = {
      id,
      version,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      sha256: digest,
      createdAt: new Date().toISOString(),
    };
    return withWorkerStateLock(this.dataDir, async () => {
      const file = await readSecretFile(this.dataDir);
      const previous = file.secrets.findLast((item) => item.id === id);
      if (previous && version === previous.version && !previous.revokedAt && previous.sha256 === digest)
        return { id, version, sha256: digest, createdAt: previous.createdAt };
      if (previous && version <= previous.version) throw new Error("secret version conflict; reload the current metadata");
      file.secrets = file.secrets.filter((item) => item.id !== id || item.revokedAt);
      file.secrets.push(record);
      await writeSecretFile(this.dataDir, file);
      return { id, version, sha256: digest, createdAt: record.createdAt };
    });
  }

  async get(id: string, version?: number): Promise<string | null> {
    const file = await readSecretFile(this.dataDir);
    const record = [...file.secrets]
      .reverse()
      .find(
        (item) =>
          item.id === id &&
          !item.revokedAt &&
          (version === undefined || item.version === version),
      );
    if (!record) return null;
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(record.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${record.id}\0${record.version}`));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64url"));
    const value = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    if (record.sha256 && sha256(value) !== record.sha256) throw new Error("secret fingerprint mismatch");
    return value;
  }

  async list(includeRevoked = false): Promise<SecretMetadata[]> {
    const file = await readSecretFile(this.dataDir);
    return file.secrets
      .filter((item) => includeRevoked || !item.revokedAt)
      .map(({ id, version, sha256, createdAt, revokedAt }) => ({
        id,
        version,
        ...(sha256 ? { sha256 } : {}),
        createdAt,
        ...(revokedAt ? { revokedAt } : {}),
      }));
  }

  async revoke(id: string, version?: number): Promise<boolean> {
    return withWorkerStateLock(this.dataDir, async () => {
      const file = await readSecretFile(this.dataDir);
      const records = file.secrets.filter((item) => item.id === id && !item.revokedAt && (version === undefined || item.version === version));
      if (!records.length) return false;
      for (const record of records) record.revokedAt = new Date().toISOString();
      await writeSecretFile(this.dataDir, file);
      return true;
    });
  }
}
