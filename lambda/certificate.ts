import * as https from "node:https";

export interface CertificateCheckResult {
  url: string;
  daysRemaining?: number;
  error?: string;
}

export async function checkCertificate(
  url: string,
): Promise<CertificateCheckResult> {
  if (!url.startsWith("https://")) {
    return {
      url,
      error: "not an https URL",
    };
  }

  try {
    const target = new URL(url);

    return await new Promise<CertificateCheckResult>((resolve) => {
      const request = https.get(target.origin, (response) => {
        const socket = response.socket as typeof response.socket & {
          getPeerCertificate?: () => { valid_to?: string };
        };

        const cert =
          typeof socket.getPeerCertificate === "function"
            ? socket.getPeerCertificate()
            : undefined;

        if (!cert || !cert.valid_to) {
          response.resume();
          resolve({ url, error: "certificate not available" });
          return;
        }

        const expiryMs = Date.parse(cert.valid_to);
        const nowMs = Date.now();
        const daysRemaining = Math.ceil(
          (expiryMs - nowMs) / (1000 * 60 * 60 * 24),
        );

        response.resume();
        resolve({ url, daysRemaining });
      });

      request.on("error", () => {
        resolve({ url, error: "certificate check failed" });
      });

      request.setTimeout(5000, () => {
        request.destroy();
        resolve({ url, error: "certificate check timeout" });
      });
    });
  } catch (err) {
    return {
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
