/**
 * Gamma bake time — pipeline step. Runs after the Gamma end-to-end tests and
 * before the production approval gate.
 *
 * WHAT IT DOES NOW
 * Holds the pipeline for BAKE_MINUTES after Gamma is deployed, so the new
 * version runs in the prod-like Gamma environment for a while before it can be
 * promoted. It does not inspect anything itself, the point of the pause is to
 * give the CloudWatch alarms + SNS notifications already defined in the stack
 * time to fire on a bad build before it reaches production. A human watching
 * the alert channel is currently the one who decides not to click "approve".
 *
 * WHY A BAKE AT ALL
 * Tests are a snapshot, it answers: "does it work right now?". Some regressions only show
 * up over time and under real runtime, a Lambda memory leak, error-rate creep,
 * latency drift. The bake window is where those have a chance to surface.
 *
 * FUTURE WORK : make this step check something and fail automatically:
 *   1. Lambda memory usage. After the window, read each Gamma Lambda's peak
 *      "Max Memory Used" (from the REPORT line in its log group, via a
 *      CloudWatch Logs Insights query) and compare to its configured
 *      memorySize. Fail if any function peaked above ~90% of its limit — it is
 *      one large input away from an out-of-memory crash, or it is leaking.
 *   2. System-health alarm. Add an alarm on the crawler/notifier Lambdas'
 *      own error rate (not the monitored-site alarms, which track third-party
 *      sites and say nothing about our deploy). Fail the bake if that alarm is
 *      in ALARM during the window — i.e. the new code is broken in Gamma.
 *   3. Error log count. Count ERROR lines across the Gamma Lambda log groups
 *      over the window (Logs Insights) and fail above a threshold.
 *
 * BAKE_MINUTES is set in pipeline-stack.ts (default 30). Will be settubg it to 0 for a demo.
 */
const minutes = Number(process.env.BAKE_MINUTES ?? 0);

async function main(): Promise<void> {
    console.log(`Bake time: holding for ${minutes} min before the production gate.`);
    await new Promise((res) => setTimeout(res, minutes * 60_000));
    console.log('Bake time complete. Proceeding to the production approval gate.');
}

main();
