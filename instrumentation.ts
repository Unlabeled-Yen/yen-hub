/**
 * Next.js instrumentation — fires once when the Node.js server boots.
 * Used here to start the Duffy summary cron loop. See:
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSummaryCron } = await import(
      "@/lib/agent/duffy/summary-cron"
    );
    startSummaryCron();

    const { startNudgeCron } = await import(
      "@/lib/agent/duffy/stale-intentions"
    );
    startNudgeCron();

    // Slice 11 — generic scheduler picks up dynamic schedules.
    const { startScheduler } = await import(
      "@/lib/agent/duffy/scheduler"
    );
    startScheduler();
  }
}
