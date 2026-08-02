/**
 * Next.js instrumentation — fires once when the Node.js server boots.
 * Used here to start the Duffy summary cron loop. See:
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Quiet mode — used by `pnpm dev` for the studio-web face so a local
    // preview does not send Telegram, fire nudges, run the scheduler, or
    // write summaries into the real user data. Ship builds never set this,
    // so production behaviour is unchanged. One knob instead of remembering
    // four; each individual *_DISABLED env still works for finer control.
    if (process.env.YEN_HUB_QUIET === "1") {
      console.log(
        "[instrumentation] quiet mode: cron/poller/scheduler/telegram not started (YEN_HUB_QUIET=1)",
      );
      return;
    }
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

    // Telegram integration — long-poll loop (idles when not configured).
    const { startTelegramPoller } = await import(
      "@/lib/agent/duffy/telegram-poller"
    );
    startTelegramPoller();
  }
}
