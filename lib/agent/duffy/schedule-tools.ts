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

const SENTINEL_REMINDER = (id: string) =>
  "End your text response with the sentinel: <<INTENT:" + id + ">>";

/* -------------------------------------------------------------------------- */
/*  propose_schedule                                                          */
/* -------------------------------------------------------------------------- */

export const proposeSchedule = tool({
  description:
    `Propose a schedule. THIS IS THE ENTRY POINT FOR ALL TIME-BASED REQUESTS — there is no manual form in the UI.

WHEN TO USE:
  - Yen mentions a time or cadence: "明天下午 1 點", "每天早上 8 點", "每週三", "每月初", "週日晚上 9 點" — anything that implies "do something at time X".
  - Yen asks you to remind him about something at a specific moment.
  - Yen asks for a recurring check (git, vault zones, periodic review).

HOW TO BUILD THE PROPOSAL:

1. action_kind:
   - "reminder"           — for "提醒我 X" / "X 點記得 X" — the action_payload is { message: string } describing what to remind about.
   - "git_unpushed_check" — only if Yen literally wants git status checks. action_payload = { repos: string[] }.
   - "vault_zone_check"   — only if Yen wants vault-zone-idle nudges. action_payload = { zone: string, days_idle: number }.

2. cron_expr — standard 5-field cron (minute hour day-of-month month day-of-week):
   - 每天 13:00          → "0 13 * * *"
   - 每天早 8:00         → "0 8 * * *"
   - 每週三 9:00         → "0 9 * * 3"
   - 每週日 21:00        → "0 21 * * 0"
   - 每月 1 號 9:00      → "0 9 1 * *"
   - Single event "明天下午 1 點" → use "0 13 * * *" + one_shot=true + not_before=tomorrow 00:00 epoch ms
   - Single event "今晚 9 點"     → use "0 21 * * *" + one_shot=true + not_before=now (no not_before needed if 9 PM is in the future)
   - Minimum interval 60 minutes — sub-hour expressions are refused.

3. one_shot — SET TO TRUE for any single-event request ("明天...", "今晚...", "12/31 前...", "下週四"). Default false for recurring.

4. not_before — epoch ms timestamp BELOW which the schedule must not fire. Use this for "明天" / "下週" / future dates to prevent today's cron match from firing immediately.
   - "明天下午 1 點" → not_before = start of tomorrow local time (ms epoch).
   - "下週三 9 點"   → not_before = start of next Monday (or whatever boundary makes sense).
   - "今晚 9 點" and 1 PM hasn't passed today → no not_before needed.
   - "今天下午 3 點" and 3 PM has passed already → REFUSE, tell Yen the moment is past.

5. name — short label Yen will see in 03 排程 panel (e.g. "看診題型提醒", "晨間 git 巡檢").

6. rationale — why this cadence is worth running, written for future-Yen.

After calling, END your text response with <<INTENT:{intent_id}>>.`,
  inputSchema: z.object({
    name: z
      .string()
      .min(2)
      .max(60)
      .describe("Short human-friendly name shown in Yen's dashboard."),
    cron_expr: z
      .string()
      .min(5)
      .max(80)
      .describe(
        "Standard 5-field cron expression. Min interval 60 minutes.",
      ),
    action_kind: z
      .enum(["reminder", "git_unpushed_check", "vault_zone_check"])
      .describe(
        "Default to 'reminder' unless Yen literally asks for git or vault-zone checks.",
      ),
    action_payload: z
      .record(z.string(), z.unknown())
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
        "TRUE for single events (明天, 今晚 X 點, 下週). FALSE / omit for recurring.",
      ),
    not_before: z
      .number()
      .int()
      .optional()
      .describe(
        "Epoch ms; the schedule MUST NOT fire before this timestamp. Use for '明天 X' / future dates to prevent today's cron from firing immediately.",
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
  }) => {
    let parsed;
    try {
      parsed = parseCron(cron_expr);
    } catch (e) {
      return {
        ok: false as const,
        error: `cron_expr 解析失敗：${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const interval = minIntervalMinutes(parsed);
    if (interval < 60) {
      return {
        ok: false as const,
        error: `最小間隔限制 60 分鐘、此表達式約 ${interval} 分鐘一次`,
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
        cron_expr,
        action_kind,
        action_payload,
        rationale,
        one_shot,
        not_before,
      },
      proposed_by: "duffy",
      rationale,
      evidence: [],
      importance: "medium",
    });

    const next = nextFire(parsed, new Date());
    return {
      ok: true as const,
      intent_id: intent.id,
      cron_description: describeCron(cron_expr),
      next_fire: next.toISOString(),
      one_shot: one_shot ?? false,
      not_before_iso: not_before ? new Date(not_before).toISOString() : null,
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
