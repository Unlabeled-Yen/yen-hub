/**
 * Duffy's intent-queue read tools — Slice 11.2.
 *
 * Before this slice Duffy could only PROPOSE intents; he had no way to
 * SEE the pending queue. So when Yen asked "我有五篇待批准、那是什麼?"
 * he couldn't answer. This tool fills that gap — read-only survey of
 * pending intents so Duffy can explain what each is.
 *
 * Why read-only: Duffy still cannot decide on Yen's behalf. He can see
 * the queue, summarise it, recommend an answer — Yen still presses the
 * button.
 */

import { tool } from "ai";
import { z } from "zod";
import { listIntents } from "@/lib/agent/storage/intents";
import type {
  Intent,
  ObservationPayload,
  SilhouetteUpdatePayload,
  SummaryPayload,
  FileCreatePayload,
  FileEditPayload,
  TodoPlanPayload,
  ScheduleCreatePayload,
  ScheduleCancelPayload,
} from "@/lib/agent/storage/types";

/** Short, human-readable title per kind — mirrors describePayload elsewhere. */
function describeTitle(intent: Intent): string {
  switch (intent.kind) {
    case "observation":
      return (intent.payload as ObservationPayload).title;
    case "silhouette_update": {
      const p = intent.payload as SilhouetteUpdatePayload;
      return `更新剪影 ${p.field}（confidence: ${p.confidence}）`;
    }
    case "summary":
      return `${(intent.payload as SummaryPayload).week} 週摘要`;
    case "file_create":
      return `新檔：${(intent.payload as FileCreatePayload).path}`;
    case "file_edit":
      return `編輯：${(intent.payload as FileEditPayload).path}`;
    case "todo_plan":
      return `待辦：${(intent.payload as TodoPlanPayload).title}`;
    case "schedule_create": {
      const p = intent.payload as ScheduleCreatePayload;
      return `新排程：${p.name}（${p.one_shot ? "單次" : "週期"}）`;
    }
    case "schedule_cancel":
      return `取消排程：${(intent.payload as ScheduleCancelPayload).schedule_id}`;
  }
}

/** Short body excerpt for context — first 200 chars of the most "meaty" field. */
function describeBody(intent: Intent): string {
  let raw = "";
  switch (intent.kind) {
    case "observation":
      raw = (intent.payload as ObservationPayload).body;
      break;
    case "silhouette_update":
      raw = (intent.payload as SilhouetteUpdatePayload).new_value;
      break;
    case "summary":
      raw = (intent.payload as SummaryPayload).pattern;
      break;
    case "file_create":
      raw = (intent.payload as FileCreatePayload).content;
      break;
    case "file_edit": {
      const p = intent.payload as FileEditPayload;
      raw = `OLD: ${p.old_text}\nNEW: ${p.new_text}`;
      break;
    }
    case "todo_plan":
      raw = (intent.payload as TodoPlanPayload).items
        .map((it) => `• ${it.text}`)
        .join("\n");
      break;
    case "schedule_create": {
      const p = intent.payload as ScheduleCreatePayload;
      raw = `cron: ${p.cron_expr} · action: ${p.action_kind} · payload: ${JSON.stringify(p.action_payload)}`;
      break;
    }
    case "schedule_cancel":
      raw = (intent.payload as ScheduleCancelPayload).rationale;
      break;
  }
  raw = raw.replace(/\s+/g, " ").trim();
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

export const listPendingIntents = tool({
  description:
    `List currently-pending intents (the ones in Yen's 02 待辦 deck). Read-only — you cannot decide on Yen's behalf, but you CAN see what's queued and explain each one to him.

WHEN TO CALL:
  - Yen asks "我有幾條待批准 / 那是什麼" — call this first, then describe.
  - Yen is uncertain whether to approve something — call this, find the matching intent, explain its rationale + impact.
  - Before proposing something new — check the queue to avoid near-duplicates.

OUTPUT: each item has { id, kind, title, body_excerpt, rationale, importance, proposed_by, age_minutes }. Use the title + body_excerpt to describe to Yen in plain language; never paste the raw JSON.`,
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Max items to return (default 20). Sorted newest first."),
    proposed_by: z
      .string()
      .optional()
      .describe(
        "Filter to a specific proposer (e.g. 'duffy' / 'yen' / 'duffy-scheduler'). Omit for all.",
      ),
  }),
  execute: async ({ limit, proposed_by }) => {
    const xs = await listIntents({
      status: "pending",
      proposed_by,
    });
    const now = Date.now();
    const out = xs
      .slice(0, limit)
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        title: describeTitle(i),
        body_excerpt: describeBody(i),
        rationale: i.rationale,
        importance: i.importance,
        proposed_by: i.proposed_by,
        proposed_at_iso: new Date(i.proposed_at).toISOString(),
        age_minutes: Math.floor((now - i.proposed_at) / 60_000),
      }));
    return {
      ok: true as const,
      count: out.length,
      total_pending: xs.length,
      intents: out,
    };
  },
});
