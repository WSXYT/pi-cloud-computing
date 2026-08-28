import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export function privateAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

export async function publicAddress(
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetcher("https://api.ipify.org", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const value = (await response.text()).trim();
    return isIP(value) > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function discoverWorkerAddresses(
  fetcher: typeof fetch = fetch,
): Promise<{ publicIp: string | null; privateIps: string[] }> {
  return {
    publicIp: await publicAddress(fetcher),
    privateIps: privateAddresses(),
  };
}
