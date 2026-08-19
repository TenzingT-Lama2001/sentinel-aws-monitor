/**
 * Canary Lambda — Phase 1.
 * Checks a single website and reports whether it's up and how fast it responded.
 * Manually invoked for this phase — no scheduling or CloudWatch publishing yet,
 * that's Phase 2.
 */

// How long a check can run before we treat the site as down.
const CHECK_TIMEOUT_MS = 5000;

/** Shape of the manual test event this Lambda expects. */
export interface CanaryEvent {
  url: string; // the site to check, e.g. "https://example.com"
}

/** Result of one availability/latency check. */
export interface CheckResult {
  url: string;
  up: boolean;
  statusCode?: number; // absent if no HTTP response came back at all (timeout/DNS/connection error)
  latencyMs?: number; // only set when up=true — a down site has no meaningful response time
  error?: string; // human-readable failure reason, only set when up=false
}

/**
 * Performs one availability/latency check against `url`.
 * Kept separate from handler() so it can be unit-tested directly.
 */
export async function checkSite(url: string): Promise<CheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS); // force-cancel if it hangs

  const startedAt = Date.now(); // clock starts at request-sent, not first-byte

  try {
    const response = await fetch(url, {
      signal: controller.signal, // lets the timeout above actually cancel this fetch
      redirect: "manual", // a 3xx counts as "up" on its own — don't chase the redirect
    });

    await response.arrayBuffer(); // wait for the full body, not just headers, before stopping the clock
    clearTimeout(timeoutId); // check finished — cancel the pending timeout

    const latencyMs = Date.now() - startedAt;
    const statusCode = response.status;

    const up = statusCode >= 200 && statusCode < 400; // 2xx/3xx = up, 4xx/5xx = down

    return {
      url,
      up,
      statusCode, // always captured, useful for debugging either way
      latencyMs: up ? latencyMs : undefined, // don't record latency for a failed check — it'd be misleading
    };
  } catch (err) {
    clearTimeout(timeoutId); // clean up either way, even on failure

    // Either our own timeout fired, or fetch failed outright (DNS, connection, TLS) —
    // both count as "down", just labelled differently for clearer logs.
    const reason = controller.signal.aborted
      ? `timed out after ${CHECK_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);

    return {
      url,
      up: false,
      error: reason,
    };
  }
}

/**
 * Lambda entry point. Manually invoked for this phase — takes one URL, runs the
 * check, logs the result, and returns it.
 */
export async function handler(event: CanaryEvent): Promise<CheckResult> {
  if (!event?.url) {
    throw new Error(
      'event.url is required, e.g. { "url": "https://example.com" }',
    );
  }

  const result = await checkSite(event.url);

  console.log(JSON.stringify(result)); // shows up in CanaryLogGroup

  return result;
}
