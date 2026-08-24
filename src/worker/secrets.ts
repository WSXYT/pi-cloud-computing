import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface EncryptedSecret {
  id: string;
  version: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
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
    return key;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid secret master key")
      throw error;
    const key = randomBytes(32);
    await writeFile(path, key, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return key;
  }
}

async function readSecretFile(dataDir: string): Promise<SecretFile> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(dataDir, "secrets.json"), "utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).secrets)
    )
      throw new Error("invalid secret file");
    return parsed as SecretFile;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid secret file")
      throw error;
    return { secrets: [] };
  }
}

async function writeSecretFile(
  dataDir: string,
  file: SecretFile,
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, "secrets.json"),
    `${JSON.stringify(file, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export interface SecretMetadata {
  id: string;
  version: number;
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
    if (!id || !Number.isInteger(version) || version < 1)
      throw new Error("secret id and version are required");
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
      createdAt: new Date().toISOString(),
    };
    const file = await readSecretFile(this.dataDir);
    file.secrets = file.secrets.filter(
      (item) => item.id !== id || item.revokedAt,
    );
    file.secrets.push(record);
    await writeSecretFile(this.dataDir, file);
    return { id, version, createdAt: record.createdAt };
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
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  async list(): Promise<SecretMetadata[]> {
    const file = await readSecretFile(this.dataDir);
    return file.secrets
      .filter((item) => !item.revokedAt)
      .map(({ id, version, createdAt, revokedAt }) => ({
        id,
        version,
        createdAt,
        ...(revokedAt ? { revokedAt } : {}),
      }));
  }

  async revoke(id: string, version?: number): Promise<boolean> {
    const file = await readSecretFile(this.dataDir);
    const record = [...file.secrets]
      .reverse()
      .find(
        (item) =>
          item.id === id &&
          !item.revokedAt &&
          (version === undefined || item.version === version),
      );
    if (!record) return false;
    record.revokedAt = new Date().toISOString();
    await writeSecretFile(this.dataDir, file);
    return true;
  }
}
