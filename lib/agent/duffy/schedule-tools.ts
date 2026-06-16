/**
 * Duffy's schedule proposers — Slice 11 + 11.1.
 *
 *   - propose_schedule(name, cron_expr, action_kind, action_payload, rationale,
 *                      one_shot?, not_before?)
 *   - cancel_schedule(schedule_id, rationale)
 *   - list_schedules({ enabled? })  → read-only
 *
 * Slice 11.1 — Duffy now drives ALL schedule creation. The UI's manual
 * form has been removed; Yen talks naturally ("明天下午 1 點提醒我看診題型"),
 * Duffy parses the time + action_kind + one_shot semantics, and proposes.
 *
 * Critical: for single events, MUST set one_shot=true AND not_before to
 * the start of the target window (e.g. tomorrow 00:00 in epoch ms). Without
 * not_before, "明天下午 1 點" cron `0 13 * * *` would resolve to today
 * if 1 PM hasn't passed yet.
 */

import { tool } from "ai";
import { z } from "zod";
import { createIntent } from "@/lib/agent/storage/intents";
import { listSchedules } from "@/lib/agent/storage/schedules";
import {
  parseCron,
  nextFire,
  minIntervalMinutes,
  describeCron,
} from "@/lib/agent/duffy/cron-utils";
import {
  parseRelativeTime,
  parseRecurrence,
  validateNotBefore,
} from "@/lib/agent/duffy/schedule-resolver";

const SENTINEL_REMINDER = (id: string) =>
  "End your text response with the sentinel: <<INTENT:" + id + ">>";

/* -------------------------------------------------------------------------- */
/*  propose_schedule                                                          */
/* -------------------------------------------------------------------------- */

export const proposeSchedule = tool({
  description:
    `Propose a schedule. THIS IS THE ENTRY POINT FOR ALL TIME-BASED REQUESTS — there is no manual form in the UI.

⏰ TIME PROTOCOL — there are TWO ways to specify time. PREFER the structured form, fall back to legacy only when impossible.

PREFERRED (server resolves, you can't get the math wrong):
  - not_before_relative: "5min" / "1h30min" / "today 21:00" / "tomorrow 09:00" / "next-mon 09:00"
  - recurrence: "once" / "daily 21:00" / "weekly mon,wed 09:00" / "monthly 1 09:00"

LEGACY (you compute epoch + cron yourself — error-prone, AVOID unless structured can't express):
  - not_before: absolute epoch ms — you MUST FIRST call get_current_time then add the offset
  - cron_expr: 5-field cron — easy to confuse field order
  - one_shot: boolean — auto-derived from "recurrence: once" if you use structured form

WHEN TO USE:
  - Yen mentions a time or cadence: "明天下午 1 點", "每天早上 8 點", "每週三", "每月初", "週日晚上 9 點" — anything that implies "do something at time X".
  - Yen asks you to remind him about something at a specific moment.
  - Yen asks for a recurring check (git, vault zones, periodic review).

HOW TO BUILD THE PROPOSAL:

1. action_kind:
   - "journal_interview"  — Use for ANY mention of '日記訪談' / '日記' — recurring ('每天/每晚 X 點做日記訪談') OR one-shot ('15 分鐘後做日記訪談', '今晚 10 點日記', '明天早上 8 點訪談我'). It fires a 'ready to start?' prompt on Telegram, sets a pending-skill marker, and waits for Yen's '好' before pushing Q1. action_payload = {} (or { ask_first: false } if you want legacy auto-push-Q1 — rarely wanted). FAR superior to 'reminder' for anything that maps to a known skill because Yen's '好' triggers the skill flow directly, bypassing free-form chat (no context bleed from prior dev/build conversations).
   - "git_unpushed_check" — only if Yen literally wants git status checks. action_payload = { repos: string[] }.
   - "vault_zone_check"   — only if Yen wants vault-zone-idle nudges. action_payload = { zone: string, days_idle: number }.
   - "reminder"           — LAST RESORT — only for '提醒我 X' where X doesn't map to any known skill (e.g. '明天下午 1 點看診', '週五帶傘'). action_payload = { message: string }. DO NOT use for diary/journal interviews — use 'journal_interview' instead, even for one-shot timing.

2. WHEN (use STRUCTURED form — server resolves, no epoch math):

   For ONE-SHOT (single event):
     "5 分鐘後做 X"        → not_before_relative: "5min" + recurrence: "once"
     "1 小時後 X"          → not_before_relative: "1h" + recurrence: "once"
     "今晚 9 點 X"         → not_before_relative: "today 21:00" + recurrence: "once"
     "明天下午 1 點 X"     → not_before_relative: "tomorrow 13:00" + recurrence: "once"
     "下週一早上 9 點 X"   → not_before_relative: "next-mon 09:00" + recurrence: "once"

   For RECURRING:
     "每天 13:00"          → recurrence: "daily 13:00" (no not_before_relative)
     "每天早 8:00"         → recurrence: "daily 08:00"
     "每週三 9:00"         → recurrence: "weekly wed 09:00"
     "每週一三五 9:00"     → recurrence: "weekly mon,wed,fri 09:00"
     "每月 1 號 9:00"      → recurrence: "monthly 1 09:00"
     "每晚 9 點日記訪談"   → recurrence: "daily 21:00" + action_kind: "journal_interview"

3. name — short label Yen will see in 03 排程 panel (e.g. "看診題型提醒", "晨間 git 巡檢").

4. rationale — why this cadence is worth running, written for future-Yen.

5. cron_expr / not_before / one_shot — LEGACY ONLY. Use only when structured form can't express your intent. If you use legacy, read the [epoch_ms] from the top of system prompt and add your offset there — DO NOT guess (2026-06-13 incident: scheduled 5 hours late by guessing). Minimum interval 15 minutes for recurring.

After calling, END your text response with <<INTENT:{intent_id}>>.`,
  inputSchema: z.object({
    name: z
      .string()
      .min(2)
      .max(60)
      .describe("Short human-friendly name shown in Yen's dashboard."),
    not_before_relative: z
      .string()
      .optional()
      .describe(
        "PREFERRED — server-resolved relative time. Use INSTEAD of computing epoch ms yourself. Forms: '5min' / '15min' / '1h' / '1h30min' / '2d' / 'today HH:MM' / 'tomorrow HH:MM' / 'next-mon HH:MM' (mon/tue/wed/thu/fri/sat/sun, with this- or next- prefix).",
      ),
    recurrence: z
      .string()
      .optional()
      .describe(
        "PREFERRED — server-resolved cron. Use INSTEAD of writing cron_expr yourself. Forms: 'once' / 'daily HH:MM' / 'weekly mon,wed HH:MM' (comma-sep weekdays) / 'monthly N HH:MM' (N=1..28).",
      ),
    cron_expr: z
      .string()
      .min(5)
      .max(80)
      .optional()
      .describe(
        "LEGACY — 5-field cron. Use only when 'recurrence' can't express your intent. Min interval 15 minutes.",
      ),
    action_kind: z
      .enum([
        "reminder",
        "git_unpushed_check",
        "vault_zone_check",
        "journal_interview",
      ])
      .describe(
        "Default to 'reminder' unless Yen literally asks for git / vault-zone checks / journal interview.",
      ),
    // NOTE: must be an explicit z.object — NOT z.record. Some providers
    // (Moonshot/Kimi) run constrained decoding from the JSON schema, and
    // z.record converts to `additionalProperties: {}` which their decoder
    // treats as falsy/false — the model is then grammatically unable to
    // emit ANY key and always sends `{}`, no matter what its reasoning
    // says. Explicit optional properties keep every field emittable.
    action_payload: z
      .object({
        message: z
          .string()
          .optional()
          .describe("reminder: what to remind Yen about. REQUIRED for reminder."),
        repos: z
          .array(z.string())
          .optional()
          .describe("git_unpushed_check: repo paths to check. REQUIRED for it."),
        zone: z
          .string()
          .optional()
          .describe("vault_zone_check: zone name. REQUIRED for it."),
        days_idle: z
          .number()
          .optional()
          .describe("vault_zone_check: idle-day threshold. REQUIRED for it."),
      })
      .describe(
        "reminder needs { message }. git_unpushed_check needs { repos: string[] }. vault_zone_check needs { zone: string, days_idle: number }.",
      ),
    rationale: z
      .string()
      .min(10)
      .max(400)
      .describe("Why this cadence + action is worth running."),
    one_shot: z
      .boolean()
      .optional()
      .describe(
        "LEGACY — auto-derived from 'recurrence: once' if using structured form. Manually set only when using legacy cron_expr.",
      ),
    not_before: z
      .number()
      .int()
      .optional()
      .describe(
        "LEGACY — epoch ms. PREFER not_before_relative. Use only when relative form can't express your intent (and you've FIRST called get_current_time).",
      ),
  }),
  execute: async ({
    name,
    cron_expr,
    action_kind,
    action_payload,
    rationale,
    one_shot,
    not_before,
    not_before_relative,
    recurrence,
  }) => {
    const now = new Date();

    // === Step 1: Resolve not_before from structured form (preferred) ===
    let resolvedNotBefore: number | undefined = not_before;
    if (not_before_relative) {
      try {
        resolvedNotBefore = parseRelativeTime(not_before_relative, now);
      } catch (e) {
        return {
          ok: false as const,
          error: `not_before_relative 解析失敗：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    if (resolvedNotBefore !== undefined) {
      const sanity = validateNotBefore(resolvedNotBefore, now);
      if (sanity) return { ok: false as const, error: sanity };
    }

    // === Step 2: Resolve cron_expr + one_shot from structured form ===
    let resolvedCronExpr = cron_expr;
    let resolvedOneShot = one_shot;
    if (recurrence) {
      try {
        const refTime = resolvedNotBefore ? new Date(resolvedNotBefore) : now;
        resolvedCronExpr = parseRecurrence(recurrence, refTime);
        resolvedOneShot = recurrence.trim().toLowerCase() === "once";
        // 2026-06-14 fix: when "once" + relative time, the cron fires at
        // HH:MM:00 (cron has no seconds) but resolvedNotBefore retained the
        // sub-minute precision of Date.now() + offset. Scheduler then sees
        // prev_fire (07:10:00) < not_before (07:10:48) and skips forever.
        // Align not_before DOWN to the cron's minute boundary.
        if (resolvedOneShot && resolvedNotBefore !== undefined) {
          const aligned = new Date(resolvedNotBefore);
          aligned.setSeconds(0, 0);
          resolvedNotBefore = aligned.getTime();
        }
      } catch (e) {
        return {
          ok: false as const,
          error: `recurrence 解析失敗：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    if (!resolvedCronExpr) {
      return {
        ok: false as const,
        error: `必須提供 recurrence（建議）或 cron_expr 其中一個`,
      };
    }

    let parsed;
    try {
      parsed = parseCron(resolvedCronExpr);
    } catch (e) {
      return {
        ok: false as const,
        error: `cron 解析失敗：${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const interval = minIntervalMinutes(parsed);
    if (interval < 15 && !resolvedOneShot) {
      return {
        ok: false as const,
        error: `recurring 最小間隔 15 分鐘、此表達式約 ${interval} 分鐘一次（one-shot 不受限）`,
      };
    }

    // Sanity check action_payload by kind — fail fast with a Duffy-friendly error.
    if (action_kind === "reminder") {
      const msg = (action_payload as { message?: unknown }).message;
      if (typeof msg !== "string" || msg.trim().length < 2) {
        return {
          ok: false as const,
          error: `reminder 需要 action_payload.message（要提醒的事）`,
        };
      }
    } else if (action_kind === "git_unpushed_check") {
      const repos = (action_payload as { repos?: unknown }).repos;
      if (!Array.isArray(repos) || repos.length === 0) {
        return {
          ok: false as const,
          error: `git_unpushed_check 需要 action_payload.repos[]`,
        };
      }
    } else if (action_kind === "vault_zone_check") {
      const zone = (action_payload as { zone?: unknown }).zone;
      const days = (action_payload as { days_idle?: unknown }).days_idle;
      if (typeof zone !== "string" || typeof days !== "number") {
        return {
          ok: false as const,
          error: `vault_zone_check 需要 action_payload.zone + days_idle`,
        };
      }
    }

    const intent = await createIntent({
      kind: "schedule_create",
      payload: {
        name,
        cron_expr: resolvedCronExpr,
        action_kind,
        action_payload,
        rationale,
        one_shot: resolvedOneShot,
        not_before: resolvedNotBefore,
      },
      proposed_by: "duffy",
      rationale,
      evidence: [],
      importance: "medium",
    });

    const next = nextFire(parsed, now);
    return {
      ok: true as const,
      intent_id: intent.id,
      cron_description: describeCron(resolvedCronExpr),
      cron_expr: resolvedCronExpr,
      next_fire: next.toISOString(),
      one_shot: resolvedOneShot ?? false,
      not_before_iso: resolvedNotBefore ? new Date(resolvedNotBefore).toISOString() : null,
      reminder: SENTINEL_REMINDER(intent.id),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  cancel_schedule                                                            */
/* -------------------------------------------------------------------------- */

export const cancelSchedule = tool({
  description:
    "Propose disabling an existing schedule. Use when Yen says a schedule isn't useful anymore. After calling, end your text response with <<INTENT:${intent_id}>>.",
  inputSchema: z.object({
    schedule_id: z
      .string()
      .startsWith("sched_")
      .describe("The id of the schedule to disable. Get it from list_schedules."),
    rationale: z
      .string()
      .min(5)
      .max(400)
      .describe("Why this schedule should stop."),
  }),
  execute: async ({ schedule_id, rationale }) => {
    const all = await listSchedules();
    const target = all.find((s) => s.id === schedule_id);
    if (!target) {
      return { ok: false as const, error: `找不到 schedule ${schedule_id}` };
    }
    if (!target.enabled) {
      return {
        ok: false as const,
        error: `schedule ${schedule_id} (${target.name}) 已是停用狀態`,
      };
    }
    const intent = await createIntent({
      kind: "schedule_cancel",
      payload: { schedule_id, rationale },
      proposed_by: "duffy",
      rationale,
      evidence: [],
      importance: "medium",
    });
    return {
      ok: true as const,
      intent_id: intent.id,
      target_name: target.name,
      reminder: SENTINEL_REMINDER(intent.id),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  list_schedules — read-only                                                 */
/* -------------------------------------------------------------------------- */

export const listSchedulesTool = tool({
  description:
    "List Duffy's autonomous schedules. Read-only — no approval needed. Use to answer \"what cron jobs do I have\" or before proposing a similar new one (avoid duplicates).",
  inputSchema: z.object({
    enabled: z
      .boolean()
      .optional()
      .describe("Filter to enabled (true) / disabled (false). Omit for all."),
  }),
  execute: async ({ enabled }) => {
    const xs = await listSchedules(enabled !== undefined ? { enabled } : undefined);
    return {
      ok: true as const,
      count: xs.length,
      schedules: xs.map((s) => {
        let next: string | null = null;
        try {
          const parsed = parseCron(s.cron_expr);
          next = nextFire(parsed, new Date()).toISOString();
        } catch {
          next = null;
        }
        return {
          id: s.id,
          name: s.name,
          cron_expr: s.cron_expr,
          cron_description: describeCron(s.cron_expr),
          action_kind: s.action_kind,
          enabled: s.enabled,
          fire_count: s.fire_count,
          last_fired_at: s.last_fired_at ?? null,
          next_fire: next,
          one_shot: s.one_shot ?? false,
          not_before: s.not_before ?? null,
          created_by: s.created_by,
          rationale: s.rationale,
        };
      }),
    };
  },
});
