/**
 * Duffy's tool kit — Slice 6 + 7A.
 *
 * READ tools surface live Yen Hub state without changing anything.
 * PROPOSE tools create Pending intents in `intents.json` — Yen must approve
 * before they become observations / silhouettes / summaries.
 *
 * All tools share one philosophical rule: side effects are bounded by what
 * Yen can see and revert (Constitution §4 + §5). A read tool returns data.
 * A propose tool creates a queued intent — nothing more.
 */

import { tool } from "ai";
import { z } from "zod";
import { createIntent } from "@/lib/agent/storage/intents";
import { listObservations } from "@/lib/agent/storage/observations";
import { listSummaries } from "@/lib/agent/storage/summaries";
import { buildAttention } from "@/lib/vault/attention-data";
import { scanTodos } from "@/lib/vault/todos";
import { readVaultFile, searchVault } from "@/lib/agent/duffy/vault-tools";
import { listSkills, useSkill } from "@/lib/agent/duffy/skill-tools";
import { webSearch, webExtract } from "@/lib/agent/duffy/web-tools";
import { searchConversations } from "@/lib/agent/storage/conversations";
import {
  readExternalFile,
  listExternalDir,
} from "@/lib/agent/duffy/external-tools";
import {
  proposeNewFile,
  proposeEditFile,
  proposeTodo,
} from "@/lib/agent/duffy/vault-write-tools";
import {
  proposeSchedule,
  cancelSchedule,
  listSchedulesTool,
} from "@/lib/agent/duffy/schedule-tools";
import { listPendingIntents } from "@/lib/agent/duffy/intent-tools";
import { proposeActionTask } from "@/lib/agent/duffy/action-tools";
import { readActionStatus } from "@/lib/agent/duffy/action-readback-tools";
import { logErrorPattern } from "@/lib/agent/duffy/error-pattern-tools";
import {
  gitStatus,
  gitLog,
  gitDiff,
  lsDir,
  tscCheck,
  npmTest,
} from "@/lib/agent/duffy/shell-tools";
import type {
  EvidenceRef,
  Importance,
  SummaryKeyNumber,
} from "@/lib/agent/storage/types";

/* -------------------------------------------------------------------------- */
/*  Time — Yen Hub clock                                                      */
/* -------------------------------------------------------------------------- */

/** ISO 8601 week-of-year. Thursday-belongs-to-week algorithm. */
function isoWeekOfYear(d: Date): number {
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNr = (target.getDay() + 6) % 7; // Mon=0..Sun=6
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

export const getCurrentTime = tool({
  description:
    "Advanced time query. The current time IS ALREADY embedded at the top of the system prompt ([現在時間] / [今天日期] / [ISO UTC] / [epoch_ms]) — use that for the common case (relative scheduling, today's date, basic timestamps). Call THIS tool only when you need extra fields not in the top block: ISO week-of-year (for cron expressions like every-second-Tuesday), weekday_num (0=Sunday, matches cron day-of-week field), sub-second precision, or English/Chinese weekday string. Read-equivalent — no approval. Cheap to call but normally unnecessary.",
  inputSchema: z.object({}),
  execute: async () => {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dowEn = now.toLocaleDateString("en-US", { weekday: "long" });
    const dowZh = now.toLocaleDateString("zh-TW", { weekday: "long" });
    // "sv-SE" locale gives YYYY-MM-DD HH:MM:SS — easiest to convert to ISO-ish local form.
    const isoLocal = now
      .toLocaleString("sv-SE", { timeZone: tz })
      .replace(" ", "T");
    return {
      iso: now.toISOString(),
      iso_local: isoLocal,
      epoch_ms: now.getTime(),
      weekday: `${dowEn} / ${dowZh}`,
      weekday_num: now.getDay(),
      week_of_year: isoWeekOfYear(now),
      tz,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Read tools                                                                */
/* -------------------------------------------------------------------------- */

export const readAttentionState = tool({
  description:
    "Read Yen's attention breakdown per vault zone (library / septic / writing / trading / etc.) for the last N days. Returns total / added / opened counts and hoardRatio per zone, plus active reading list. Call this when Yen asks anything about where his focus is going or whether he's hoarding.",
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(7)
      .describe("Window size in days. Defaults to 7. Use 14/30 for longer-range views."),
  }),
  execute: async ({ days }) => {
    const data = await buildAttention(days ?? 7);
    return {
      window: data.window,
      zones: data.zones.map((z) => ({
        zone: z.zone,
        label: z.label,
        total: z.total,
        added: z.added,
        opened: z.opened,
        hoardRatio: z.hoardRatio,
      })),
      activelyReading: data.library.activelyReading.slice(0, 5).map((b) => ({
        title: b.displayTitle ?? b.name,
        chaptersOpened: b.openedChapters,
      })),
      newlyHoarded: data.library.newlyHoarded.slice(0, 5).map((b) => ({
        title: b.displayTitle ?? b.name,
        chaptersAdded: b.addedChapters,
      })),
    };
  },
});

export const readTodos = tool({
  description:
    "List Yen's current open todos from his Queue zone (vault `05 - Queue/`). Returns the most recent items with file path, line, and category. Use when Yen asks about what's piling up, what he committed to, or what's been stuck.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Cap on items returned. Defaults to 20."),
  }),
  execute: async ({ limit }) => {
    const todos = await scanTodos(limit ?? 20, "queue");
    return {
      count: todos.length,
      items: todos.map((t) => ({
        file: t.file,
        text: t.text,
        category: t.category,
        zone: t.zone,
      })),
    };
  },
});

export const readObservationsHistory = tool({
  description:
    "List your past approved observations of Yen, newest first. Use this when Yen asks 'what have you noticed before' or to avoid proposing something you've already raised this week.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(10),
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only return observations within the last N days."),
  }),
  execute: async ({ limit, sinceDays }) => {
    const since = sinceDays ? Date.now() - sinceDays * 86_400_000 : undefined;
    const obs = await listObservations({ agent: "duffy", since });
    return {
      count: obs.length,
      items: obs.slice(0, limit ?? 10).map((o) => ({
        id: o.id,
        title: o.title,
        zone: o.zone,
        created_at: o.created_at,
        importance: o.importance,
        reason: o.reason,
        valid_until: o.valid_until,
      })),
    };
  },
});

export const searchObservations = tool({
  description:
    "Text-search past approved observations (case-insensitive substring match against title, body, reason, and zone). Use BEFORE proposing — avoid repeating yourself on Yen.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Substring to search."),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async ({ query, limit }) => {
    const q = query.toLowerCase();
    const all = await listObservations({ agent: "duffy" });
    const matches = all.filter((o) => {
      return (
        o.title.toLowerCase().includes(q) ||
        o.body.toLowerCase().includes(q) ||
        o.reason.toLowerCase().includes(q) ||
        (o.zone ?? "").toLowerCase().includes(q)
      );
    });
    return {
      count: matches.length,
      items: matches.slice(0, limit ?? 10).map((o) => ({
        id: o.id,
        title: o.title,
        zone: o.zone,
        importance: o.importance,
        created_at: o.created_at,
        valid_until: o.valid_until,
        body: o.body.length > 200 ? o.body.slice(0, 200) + "…" : o.body,
      })),
    };
  },
});

export const readConversationHistory = tool({
  description:
    "Look up Yen's past conversations with you. With no query, returns the N most-recent conversations (newest first) with their titles + first user message. With a query, searches all conversations for messages containing that substring (case-insensitive) and returns hits with snippet. Use when Yen asks 'what did we talk about' / '上次/上週聊過...' or when you need to verify whether you've already discussed something. Cite the conversation id when you reference one.",
  inputSchema: z.object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe("Substring to search across all message content. Omit for recent-list mode."),
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only include conversations updated in the last N days."),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  execute: async ({ query, sinceDays, limit }) => {
    const hits = await searchConversations({ query, sinceDays, limit });
    return {
      count: hits.length,
      mode: query ? ("search" as const) : ("recent" as const),
      items: hits.map((h) => ({
        id: h.id,
        title: h.title ?? "(untitled)",
        updated_at_iso: new Date(h.updatedAt).toISOString(),
        message_count: h.messageCount,
        snippet: h.snippet,
        matched_role: h.matchedRole,
      })),
    };
  },
});

export const searchOldSummaries = tool({
  description:
    "List older weekly summaries, newest first. The CURRENT week's summary is already injected in your system prompt — use this tool for prior weeks. Useful when Yen asks about long-term trends or a specific week.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20).default(8),
  }),
  execute: async ({ limit }) => {
    const items = await listSummaries(limit ?? 8);
    return {
      count: items.length,
      items: items.map((s) => ({
        id: s.id,
        week: s.week,
        headline: s.headline,
        pattern: s.pattern,
        key_numbers: s.key_numbers,
      })),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Propose tools                                                             */
/* -------------------------------------------------------------------------- */

const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attention"),
    zone: z.string(),
    metric: z.enum(["total", "added", "opened", "hoardRatio"]),
    value: z.number(),
    window: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("vault_file"),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("todo"),
    file: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("observation"),
    id: z.string(),
  }),
]);

const ImportanceSchema = z
  .enum(["high", "medium", "low"])
  .describe(
    "HIGH = repeated past mistake / long-running imbalance / risk signal (rare). MEDIUM = worth recording (default). LOW = note-only.",
  );

export const proposeObservation = tool({
  description:
    "Propose a new observation about Yen's state. This does NOT write the observation directly — it creates a Pending intent for Yen to approve. After calling this, your final text response MUST include the sentinel `<<INTENT:${intent_id}>>` so the chat UI renders the approval card. **Slice 8**: if the observation captures a commitment Yen made (something he said he intends to do/finish/decide), set `isIntention: true` so the stale-nudge cron can later remind him.",
  inputSchema: z.object({
    title: z.string().max(60),
    body: z.string(),
    zone: z.string().optional(),
    windowDays: z.number().int().min(1).max(365).optional(),
    rationale: z.string(),
    evidence: z.array(EvidenceSchema).default([]),
    importance: ImportanceSchema,
    isIntention: z
      .boolean()
      .default(false)
      .describe(
        "Set true ONLY when this observation captures Yen saying he intends to do/finish/decide something. Skip for ordinary observations.",
      ),
    intentionTargetDate: z
      .string()
      .optional()
      .describe(
        "Optional ISO date (YYYY-MM-DD) if Yen named a deadline. Don't invent one if he didn't.",
      ),
    intentionSourceText: z
      .string()
      .optional()
      .describe(
        "Verbatim phrase from Yen that triggered the intention mark. Helps the future nudge feel like his words, not yours.",
      ),
    validUntil: z
      .string()
      .optional()
      .describe(
        "v2 Gap A — optional ISO date (YYYY-MM-DD) after which this observation auto-expires from your active memory. Use for time-bound facts ('未來兩週優先寫作線'); skip for durable traits. Don't invent one.",
      ),
    supersedesObservationId: z
      .string()
      .optional()
      .describe(
        "v2 Gap A — if this observation REPLACES an older one (the old belief is now wrong/outdated), pass the old observation's id. On approve, the old one is archived so it stops surfacing. Find the id via search_observations / read_observations_history first.",
      ),
  }),
  execute: async ({
    title,
    body,
    zone,
    windowDays,
    rationale,
    evidence,
    importance,
    isIntention,
    intentionTargetDate,
    intentionSourceText,
    validUntil,
    supersedesObservationId,
  }) => {
    const intentionMeta = isIntention
      ? {
          status: "open" as const,
          last_touched_at: Date.now(),
          target_date: intentionTargetDate
            ? Date.parse(intentionTargetDate)
            : undefined,
          source_text: intentionSourceText,
        }
      : undefined;
    const intent = await createIntent({
      kind: "observation",
      proposed_by: "duffy",
      rationale,
      evidence: (evidence ?? []) as EvidenceRef[],
      importance: importance as Importance,
      payload: {
        title,
        body,
        zone,
        window: windowDays ? { days: windowDays } : undefined,
        intention: intentionMeta,
        valid_until: validUntil ? Date.parse(validUntil) : undefined,
        supersedes: supersedesObservationId,
      },
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      reminder:
        "End your text response with the sentinel: <<INTENT:" +
        intent.id +
        ">>",
    };
  },
});

const SilhouetteFieldSchema = z.enum([
  "identity",
  "style",
  "values",
  "boundaries",
  "priorities",
  "full",
]);

export const proposeSilhouetteUpdate = tool({
  description:
    'Propose an update to Yen\'s silhouette (Duffy\'s portrait of him). Only do this when observation patterns materially change your understanding of Yen. `field="full"` replaces all 5 sections at once (used for bootstrap or major rewrites); `new_value` then must be a JSON-stringified object with keys identity/style/values/boundaries/priorities. Other field values are plain text replacing just that section. Always include `reason` — Yen sees it verbatim. After calling, end response with the intent sentinel.',
  inputSchema: z.object({
    field: SilhouetteFieldSchema,
    new_value: z.string(),
    reason: z.string(),
    confidence: z
      .enum(["low", "medium", "high"])
      .describe("Your self-assessed confidence in this version's accuracy."),
    importance: ImportanceSchema.default("medium"),
  }),
  execute: async ({ field, new_value, reason, confidence, importance }) => {
    const intent = await createIntent({
      kind: "silhouette_update",
      proposed_by: "duffy",
      rationale: reason,
      importance: importance as Importance,
      payload: {
        field,
        new_value,
        reason,
        confidence,
      },
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      reminder:
        "End your text response with the sentinel: <<INTENT:" +
        intent.id +
        ">>",
    };
  },
});

const KeyNumberSchema = z.object({
  label: z.string(),
  value: z.string(),
  delta: z.string().optional(),
});

export const proposeSummary = tool({
  description:
    "Propose a weekly summary. Triggered by Sunday cron normally; can also be invoked ad-hoc if Yen asks for a recap. Headline = one sentence; key_numbers = 3-7 metrics with labels; pattern = one paragraph; proposed_actions = 1-3 suggestions. After calling, end response with the intent sentinel.",
  inputSchema: z.object({
    week: z
      .string()
      .regex(/^\d{4}-W\d{2}$/, "ISO week like 2026-W23")
      .describe("ISO week label, e.g. 2026-W23."),
    headline: z.string(),
    key_numbers: z.array(KeyNumberSchema).min(1).max(8),
    pattern: z.string(),
    proposed_actions: z.array(z.string()).max(5),
    source_observations: z
      .array(z.string())
      .default([])
      .describe("observation ids that informed this summary."),
    importance: ImportanceSchema.default("medium"),
  }),
  execute: async ({
    week,
    headline,
    key_numbers,
    pattern,
    proposed_actions,
    source_observations,
    importance,
  }) => {
    const intent = await createIntent({
      kind: "summary",
      proposed_by: "duffy",
      rationale: `Weekly summary for ${week}`,
      importance: importance as Importance,
      payload: {
        week,
        headline,
        key_numbers: key_numbers as SummaryKeyNumber[],
        pattern,
        proposed_actions: proposed_actions ?? [],
        source_observations: source_observations ?? [],
      },
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      reminder:
        "End your text response with the sentinel: <<INTENT:" +
        intent.id +
        ">>",
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Toolset                                                                   */
/* -------------------------------------------------------------------------- */

export const duffyTools = {
  // Time — system clock (always fresh, never cached)
  get_current_time: getCurrentTime,
  // Read — Yen Hub state
  read_attention_state: readAttentionState,
  read_todos: readTodos,
  read_observations_history: readObservationsHistory,
  search_observations: searchObservations,
  search_old_summaries: searchOldSummaries,
  read_conversation_history: readConversationHistory,
  // Read — Vault (Slice 7B)
  read_vault_file: readVaultFile,
  search_vault: searchVault,
  // Read — Skills (Slice 9)
  list_skills: listSkills,
  use_skill: useSkill,
  // Read — Web (Slice 9)
  web_search: webSearch,
  web_extract: webExtract,
  // Read — External directories (Slice 8.10, consolidated 11.3)
  read_external_file: readExternalFile,
  list_external_dir: listExternalDir,
  // Propose — agent state
  propose_observation: proposeObservation,
  propose_silhouette_update: proposeSilhouetteUpdate,
  propose_summary: proposeSummary,
  // Propose — vault writes (L2, Slice 9)
  propose_new_file: proposeNewFile,
  propose_edit_file: proposeEditFile,
  propose_todo: proposeTodo,
  // Schedules (Slice 11) — Duffy self-orchestrates
  propose_schedule: proposeSchedule,
  cancel_schedule: cancelSchedule,
  list_schedules: listSchedulesTool,
  // Intent queue (Slice 11.2) — Duffy can see the pending deck
  list_pending_intents: listPendingIntents,
  // Action layer (2026-06-16) — file a task for the local watcher to run
  propose_action_task: proposeActionTask,
  // Action read-back (PRD v2 Gap C) — close the loop on a filed task
  read_action_status: readActionStatus,
  // Self-correction (PRD v2 Gap B) — durable error-pattern log
  log_error_pattern: logErrorPattern,
  // Shell (方向 2 收尾) — whitelist preset commands, read-only spirit
  git_status: gitStatus,
  git_log: gitLog,
  git_diff: gitDiff,
  ls_dir: lsDir,
  tsc_check: tscCheck,
  npm_test: npmTest,
};
