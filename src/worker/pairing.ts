import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { WorkerState, WorkerToken } from "./state.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPairing(
  state: WorkerState,
  now = Date.now(),
): { code: string; expiresAt: string } {
  const code = randomBytes(6).toString("base64url");
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
  state.pairingCodeHash = hash(code);
  state.pairingExpiresAt = expiresAt;
  return { code, expiresAt };
}

export function completePairing(
  state: WorkerState,
  code: string,
  now = Date.now(),
): string {
  if (!state.pairingCodeHash || !state.pairingExpiresAt)
    throw new Error("pairing code is not active");
  if (Date.parse(state.pairingExpiresAt) <= now) {
    delete state.pairingCodeHash;
    delete state.pairingExpiresAt;
    throw new Error("pairing code expired");
  }
  const expected = Buffer.from(state.pairingCodeHash, "hex");
  const received = Buffer.from(hash(code), "hex");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    throw new Error("pairing code invalid");
  delete state.pairingCodeHash;
  delete state.pairingExpiresAt;
  const token = randomBytes(32).toString("base64url");
  const tokenRecord: WorkerToken = {
    id: randomBytes(8).toString("hex"),
    hash: hash(token),
    createdAt: new Date(now).toISOString(),
  };
  state.tokens.push(tokenRecord);
  return token;
}

export function revokeToken(
  state: WorkerState,
  tokenId: string,
  now = Date.now(),
): boolean {
  const token = state.tokens.find(
    (item) => item.id === tokenId && !item.revokedAt,
  );
  if (!token) return false;
  token.revokedAt = new Date(now).toISOString();
  return true;
}

export function authenticateToken(
  state: WorkerState,
  token: string,
): WorkerToken | null {
  const received = Buffer.from(hash(token), "hex");
  for (const item of state.tokens) {
    if (item.revokedAt) continue;
    const expected = Buffer.from(item.hash, "hex");
    if (
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    )
      return item;
  }
  return null;
}
