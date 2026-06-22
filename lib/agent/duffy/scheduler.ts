/**
 * Generic scheduler loop — Slice 11.
 *
 * Polls every minute, fires any Schedule whose prev-fire window is after
 * its last_fired_at. Coexists with hardcoded summary-cron / stale-intentions
 * for v1 — they keep running independently. v2 will migrate those to
 * schedules.json once this loop is proven stable.
 *
 * Disable with env `DYNAMIC_SCHEDULER_DISABLED=1`. Useful in dev.
 *
 * Hooked into Next.js via `instrumentation.ts`.
 */

import {
  listSchedules,
  markFired,
  setEnabled,
} from "@/lib/agent/storage/schedules";
import { parseCron, prevFire } from "@/lib/agent/duffy/cron-utils";
import { runScheduleAction } from "@/lib/agent/duffy/schedule-actions";
import { maybeRunAutoPilot } from "@/lib/agent/duffy/auto-pilot";

const POLL_INTERVAL_MS = 60 * 1000; // 1 min

type State = {
  started: boolean;
  timer: NodeJS.Timeout | null;
};

const state: State = { started: false, timer: null };

async function tick(): Promise<void> {
  const now = new Date();
  // Slice 12 Phase 4 — fire-and-forget auto-pilot evaluation. It has its
  // own 24h internal cooldown so calling on every tick is cheap.
  void maybeRunAutoPilot();

  const schedules = await listSchedules({ enabled: true });

  for (const s of schedules) {
    let parsed;
    try {
      parsed = parseCron(s.cron_expr);
    } catch (e) {
      console.warn(`[scheduler] skipping ${s.id} — bad cron:`, e);
      continue;
    }

    let prev: Date;
    try {
      prev = prevFire(parsed, now);
    } catch {
      continue;
    }

    // Honour not_before — single-event schedules use it to disambiguate
    // "明天下午 1 點" from "今天下午 1 點 (if 1 PM hasn't passed)".
    if (s.not_before && prev.getTime() < s.not_before) continue;

    // Fire if the most recent scheduled time is strictly after the last
    // recorded fire. For new schedules (last_fired_at = null), missed
    // fires only count from creation time forward — a schedule didn't
    // exist before created_at, so a cron boundary that passed before
    // creation isn't a missed fire. This caused a real bug (2026-06-10):
    // Duffy creates `*/15 * * * *` one_shot at 06:41 → scheduler treats
    // 06:30 as a missed fire → notification fires immediately instead of
    // at the promised 06:45 boundary.
    const last = s.last_fired_at ?? s.created_at;
    const sinceLastTick = now.getTime() - POLL_INTERVAL_MS;
    if (prev.getTime() <= last) continue;
    if (prev.getTime() < sinceLastTick) {
      // Missed fire (laptop slept etc.) — log and still execute once so
      // the user isn't silently skipped.
      console.log(
        `[scheduler] ${s.id} missed fire (${prev.toISOString()}), running now`,
      );
    }

    console.log(`[scheduler] firing ${s.id} (${s.name})`);
    // Claim the fire BEFORE running the action. Recording the fire window up
    // front makes a fire idempotent across a crash/restart: if the process dies
    // during runScheduleAction, last_fired_at has already advanced past this
    // window, so the next boot's catch-up tick won't run it again and
    // double-write its observation. Trade-off: a crash mid-action loses THIS
    // run's effect (no retry) — for reminders/observations a missed one-off
    // beats a duplicate that reappears on every unlucky restart. Mark the fire
    // WINDOW (prev), not now, so the next tick's `prev <= last` dedupe is exact.
    try {
      await markFired(s.id, prev.getTime());
      if (s.one_shot) {
        await setEnabled(s.id, false);
        console.log(`[scheduler] ${s.id} one_shot fired — disabling`);
      }
    } catch (e) {
      console.error(`[scheduler] ${s.id} claim failed, not firing:`, e);
      continue;
    }
    try {
      await runScheduleAction(s);
    } catch (e) {
      console.error(`[scheduler] ${s.id} action failed:`, e);
    }
  }
}

export function startScheduler(): void {
  if (state.started) return;
  if (process.env.DYNAMIC_SCHEDULER_DISABLED === "1") {
    console.log("[scheduler] disabled via DYNAMIC_SCHEDULER_DISABLED=1");
    return;
  }
  state.started = true;
  state.timer = setInterval(() => {
    void tick().catch((e) => console.error("[scheduler] tick error:", e));
  }, POLL_INTERVAL_MS);
  // Fire once at startup so missed-while-app-was-off schedules can catch up.
  void tick().catch((e) => console.error("[scheduler] initial tick error:", e));
  console.log(
    `[scheduler] started; poll every ${POLL_INTERVAL_MS / 1000}s`,
  );
}

export function stopScheduler(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
}
