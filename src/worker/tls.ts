import { X509Certificate } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CertificatePaths {
  certificate: string;
  privateKey: string;
}

export function certificatePaths(dataDir: string): CertificatePaths {
  return {
    certificate: join(dataDir, "tls", "server.crt"),
    privateKey: join(dataDir, "tls", "server.key"),
  };
}

export async function generateSelfSignedCertificate(
  dataDir: string,
  ip: string,
  days = 365,
): Promise<CertificatePaths> {
  if (isIP(ip) === 0)
    throw new Error("TLS certificate IP must be an IPv4 or IPv6 address");
  const paths = certificatePaths(dataDir);
  await mkdir(join(dataDir, "tls"), { recursive: true, mode: 0o700 });
  await execFileAsync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      String(days),
      "-keyout",
      paths.privateKey,
      "-out",
      paths.certificate,
      "-subj",
      "/CN=pi-cloud-worker",
      "-addext",
      `subjectAltName=IP:${ip}`,
    ],
    { windowsHide: true },
  );
  return paths;
}

export async function certificateFingerprint(
  certificatePath: string,
): Promise<string> {
  return new X509Certificate(await readFile(certificatePath)).fingerprint256;
}

export async function ensureSelfSignedCertificate(
  dataDir: string,
  ip: string,
): Promise<{ paths: CertificatePaths; fingerprint: string }> {
  const paths = certificatePaths(dataDir);
  try {
    await readFile(paths.certificate);
    await readFile(paths.privateKey);
  } catch {
    await generateSelfSignedCertificate(dataDir, ip);
  }
  return {
    paths,
    fingerprint: await certificateFingerprint(paths.certificate),
  };
}
