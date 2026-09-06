/**
 * DNS resolution check.
 * A hostname that no longer resolves is a distinct failure from "the site
 * returned an error" — it usually means the domain lapsed or its records were
 * changed. checkSite() would catch it too, but only as a generic "down", so
 * this gets its own metric and alarm (see docs / README "DNS Resolution
 * Monitoring").
 */

import { promises as dns } from "node:dns";

// A slow or unresponsive resolver must not hang the whole crawl.
const DNS_TIMEOUT_MS = 5000;

/** Result of one DNS resolution check. */
export interface DnsResult {
  url: string;
  resolved: boolean;
  addresses?: string[]; // resolved IPs, only when the lookup succeeded
  error?: string; // why the lookup failed, only when it didn't
}

/**
 * Resolves the URL's hostname to one or more IP addresses, capped at
 * DNS_TIMEOUT_MS. `resolved` is true only when at least one address came back.
 * Any failure (invalid URL, NXDOMAIN, timeout) resolves — never rejects — with
 * `resolved: false` and an `error`, so one site can't abort the crawl.
 */
export async function checkDns(url: string): Promise<DnsResult> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { url, resolved: false, error: "invalid URL" };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`DNS lookup timed out after ${DNS_TIMEOUT_MS}ms`),
            ),
          DNS_TIMEOUT_MS,
        );
      }),
    ]);

    return {
      url,
      resolved: addresses.length > 0,
      addresses: addresses.map((entry) => entry.address),
    };
  } catch (err) {
    return {
      url,
      resolved: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer); // don't keep the event loop alive after a fast success
  }
}
