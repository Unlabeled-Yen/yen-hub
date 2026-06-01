/**
 * Duffy's tool kit — Slice 6 / Duffy v0.
 *
 * READ tools surface live Yen Hub state without changing anything.
 * PROPOSE tools create Pending intents in `intents.json` — Yen must approve
 * before they become observations.
 *
 * All tools share one philosophical rule: side effects are bounded by what
 * Yen can see and revert (Constitution §4 + §5). A read tool returns data.
 * A propose tool creates a queued intent — nothing more.
 */

import { tool } from "ai";
import { z } from "zod";
import { createIntent } from "@/lib/agent/storage/intents";
import { listObservations } from "@/lib/agent/storage/observations";
import { buildAttention } from "@/lib/vault/attention-data";
import { scanTodos } from "@/lib/vault/todos";
import type { EvidenceRef } from "@/lib/agent/storage/types";

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
    // Compact projection — LLM doesn't need book-level granularity in most
    // calls; only the zone deltas + a few headline reads.
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
        reason: o.reason,
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

export const proposeObservation = tool({
  description:
    "Propose a new observation about Yen's state. This does NOT write the observation directly — it creates a Pending intent for Yen to approve. Use this when you spot a pattern worth recording (hoarding, stagnation, distraction shift, breakthrough). After calling this, your final text response MUST include the sentinel `<<INTENT:${intent_id}>>` so the chat UI renders the approval card.",
  inputSchema: z.object({
    title: z
      .string()
      .max(60)
      .describe("One-line summary. Max ~24 Chinese characters preferred."),
    body: z
      .string()
      .describe(
        "Full description with concrete numbers from the tools you called. Mention zones, ratios, counts.",
      ),
    zone: z
      .string()
      .optional()
      .describe("Primary zone this observation concerns, if one dominates."),
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Time window the observation covers (days)."),
    rationale: z
      .string()
      .describe(
        "Why this is worth recording right now. The user will see this verbatim in the approval card.",
      ),
    evidence: z
      .array(EvidenceSchema)
      .default([])
      .describe(
        "Concrete data points backing the observation. Prefer attention/zone refs and todo/file refs.",
      ),
  }),
  execute: async ({ title, body, zone, windowDays, rationale, evidence }) => {
    const intent = await createIntent({
      kind: "observation",
      proposed_by: "duffy",
      rationale,
      evidence: (evidence ?? []) as EvidenceRef[],
      payload: {
        title,
        body,
        zone,
        window: windowDays ? { days: windowDays } : undefined,
      },
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      // Reminder to the LLM — without the sentinel, Yen can't see the card.
      reminder:
        "Now end your text response with the sentinel: <<INTENT:" +
        intent.id +
        ">>",
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Toolset                                                                   */
/* -------------------------------------------------------------------------- */

export const duffyTools = {
  read_attention_state: readAttentionState,
  read_todos: readTodos,
  read_observations_history: readObservationsHistory,
  propose_observation: proposeObservation,
};
