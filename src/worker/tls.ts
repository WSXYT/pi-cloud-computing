import { createPrivateKey, X509Certificate } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensurePrivateDirectory, withPrivateFileLock, writePrivateFile } from "../storage.js";

const execFileAsync = promisify(execFile);

async function opensslExecutable(): Promise<string> {
  if (process.platform !== "win32") return "openssl";
  const { stdout } = await execFileAsync("git", ["--exec-path"], { windowsHide: true });
  const executable = resolve(stdout.trim(), "../..", "bin", "openssl.exe");
  await access(executable);
  return executable;
}

export interface CertificatePaths {
  certificate: string;
  privateKey: string;
}

export function certificatePaths(dataDir: string): CertificatePaths {
  return { certificate: join(dataDir, "tls", "server.crt"), privateKey: join(dataDir, "tls", "server.key") };
}

export async function generateSelfSignedCertificate(dataDir: string, ip: string, days = 365): Promise<CertificatePaths> {
  if (isIP(ip) === 0) throw new Error("TLS certificate IP must be an IPv4 or IPv6 address");
  const paths = certificatePaths(dataDir);
  await ensurePrivateDirectory(join(dataDir, "tls"));
  const temporary = await mkdtemp(join(dataDir, "tls", ".generate-"));
  try {
    await ensurePrivateDirectory(temporary);
    await execFileAsync(await opensslExecutable(), [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", String(days),
      "-keyout", join(temporary, "key.pem"), "-out", join(temporary, "cert.pem"),
      "-subj", "/CN=pi-cloud-worker", "-addext", `subjectAltName=IP:${ip}`,
    ], { windowsHide: true });
    await writePrivateFile(paths.privateKey, await readFile(join(temporary, "key.pem")));
    await writePrivateFile(paths.certificate, await readFile(join(temporary, "cert.pem")));
    return paths;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function certificateFingerprint(certificatePath: string): Promise<string> {
  return new X509Certificate(await readFile(certificatePath)).fingerprint256;
}

async function readExisting(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function ensureSelfSignedCertificate(dataDir: string, ip: string, rotate = false): Promise<{
  paths: CertificatePaths; fingerprint: string; certificate: Buffer; privateKey: Buffer;
}> {
  if (isIP(ip) === 0) throw new Error("TLS certificate IP must be an IPv4 or IPv6 address");
  const paths = certificatePaths(dataDir);
  return withPrivateFileLock(paths.privateKey, async () => {
    let certificate = await readExisting(paths.certificate);
    let privateKey = await readExisting(paths.privateKey);
    if (rotate || (!certificate && !privateKey)) {
      await generateSelfSignedCertificate(dataDir, ip);
      certificate = await readFile(paths.certificate);
      privateKey = await readFile(paths.privateKey);
    }
    if (!certificate || !privateKey) throw new Error("TLS files are incomplete; restore them or explicitly run worker tls rotate");
    const parsed = new X509Certificate(certificate);
    if (!parsed.checkPrivateKey(createPrivateKey(privateKey))) throw new Error("TLS certificate and private key do not match");
    if (!parsed.checkIP(ip)) throw new Error("TLS certificate does not cover this IP; run worker tls rotate --ip <address>");
    if (Date.parse(parsed.validTo) <= Date.now()) throw new Error("TLS certificate has expired; run worker tls rotate");
    return { paths, fingerprint: parsed.fingerprint256, certificate, privateKey };
  });
}
