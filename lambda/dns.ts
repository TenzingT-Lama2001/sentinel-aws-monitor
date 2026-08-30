import { promises as dns } from "node:dns";

const DNS_TIMEOUT_MS = 5000;

export interface DnsResult {
  url: string;
  resolved: boolean;
  addresses?: string[];
  error?: string;
}

export async function checkDns(url: string): Promise<DnsResult> {
  let hostname: string;

  try {
    hostname = new URL(url).hostname;
  } catch {
    return {
      url,
      resolved: false,
      error: "invalid URL",
    };
  }

  try {
    const addresses = (await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`DNS lookup timed out after ${DNS_TIMEOUT_MS}ms`)),
          DNS_TIMEOUT_MS,
        );
      }),
    ])) as Array<{ address: string }>;

    return {
      url,
      resolved: addresses.length > 0,
      addresses: addresses.map((address) => address.address),
    };
  } catch (err) {
    return {
      url,
      resolved: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
