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
import type {
  EvidenceRef,
  Importance,
  SummaryKeyNumber,
} from "@/lib/agent/storage/types";

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
};
