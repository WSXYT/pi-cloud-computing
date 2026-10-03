export const PROTOCOL_VERSION = 1 as const;
export const CLOUD_VERSION = "0.2.1";
export const MIN_PI_VERSION = "0.85.1";

/** Stable SemVer releases only; no upper-version whitelist. Build metadata is ignored. */
export function supportsPiVersion(version: unknown): boolean {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) return false;
  const parts = version.split("+")[0]!.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const minimum = MIN_PI_VERSION.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i] !== minimum[i]) return parts[i]! > minimum[i]!;
  }
  return true;
}
