/**
 * TLS certificate check.
 * checkSite() uses fetch(), which never exposes the peer certificate, so cert
 * expiry needs its own raw TLS handshake. Kept separate from the canary because
 * "the cert is about to expire" and "the site is down" are different failures
 * with different alarms.
 */

import * as tls from "node:tls";

// A slow or unreachable host must not hang the whole crawl.
const TLS_TIMEOUT_MS = 5000;

/** Result of one certificate check. */
export interface CertificateResult {
  url: string;
  /**
   * Whole days until the certificate's notAfter date. Negative once the cert
   * has already expired. Absent when the handshake didn't complete.
   */
  daysRemaining?: number;
  error?: string; // set instead of daysRemaining when the check failed
}

/**
 * Opens a TLS connection to the URL's host on 443 and reports how many days are
 * left on the certificate it presents. `rejectUnauthorized` is off on purpose:
 * an expired or hostname-mismatched cert should still report its date (as a
 * small or negative number) rather than collapse into a generic error — a hard
 * TLS failure is already caught by the availability check.
 */
export function checkCertificate(url: string): Promise<CertificateResult> {
  return new Promise((resolve) => {
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        resolve({ url, error: "not an https URL" });
        return;
      }
      host = parsed.hostname;
    } catch {
      resolve({ url, error: "invalid URL" });
      return;
    }

    const socket = tls.connect({
      host,
      port: 443,
      servername: host, // SNI — hosts serving several certs need this to pick the right one
      rejectUnauthorized: false,
    });

    // resolve() is a no-op after the first call, so whichever handler fires
    // first wins and the others are harmless.
    socket.setTimeout(TLS_TIMEOUT_MS, () => {
      socket.destroy();
      resolve({
        url,
        error: `TLS handshake timed out after ${TLS_TIMEOUT_MS}ms`,
      });
    });

    socket.on("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.end();

      if (!cert || !cert.valid_to) {
        resolve({ url, error: "host presented no certificate" });
        return;
      }

      const msRemaining = new Date(cert.valid_to).getTime() - Date.now();
      resolve({ url, daysRemaining: Math.floor(msRemaining / 86_400_000) });
    });

    socket.on("error", (err) => {
      resolve({ url, error: err.message });
    });
  });
}
