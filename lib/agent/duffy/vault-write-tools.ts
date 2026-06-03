/**
 * Duffy's vault-write proposers — Slice 9 (L2).
 *
 *   - propose_new_file(path, content, rationale)
 *   - propose_edit_file(path, old_text, new_text, rationale)
 *   - propose_todo(title, items[], rationale)
 *
 * None write directly. Each creates a Pending intent of a new kind
 * (file_create / file_edit / todo_plan). Yen approves in the chat;
 * the decide route does the actual filesystem write under his control.
 *
 * Hardening lives in the decide route (path traversal, old_text uniqueness,
 * atomic rename). The tools just package the proposal.
 */

import { tool } from "ai";
import { z } from "zod";
import { createIntent } from "@/lib/agent/storage/intents";
import type {
  EvidenceRef,
  Importance,
  TodoPlanItem,
} from "@/lib/agent/storage/types";

const ImportanceSchema = z
  .enum(["high", "medium", "low"])
  .default("medium")
  .describe(
    "Default medium. Use high only when the change is materially load-bearing.",
  );

const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attention"),
    zone: z.string(),
    metric: z.enum(["total", "added", "opened", "hoardRatio"]),
    value: z.number(),
    window: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("vault_file"), path: z.string() }),
  z.object({ kind: z.literal("todo"), file: z.string(), text: z.string() }),
  z.object({ kind: z.literal("observation"), id: z.string() }),
]);

const SENTINEL_REMINDER = (id: string) =>
  "End your text response with the sentinel: <<INTENT:" + id + ">>";

/* -------------------------------------------------------------------------- */
/*  propose_new_file                                                          */
/* -------------------------------------------------------------------------- */

export const proposeNewFile = tool({
  description:
    "Propose creating a NEW Markdown file in Yen's vault. The file MUST NOT already exist. Use when Yen says he wants to start writing/journalling/templating something concrete that doesn't have a file yet. Yen approves in the chat; nothing lands until then. After calling this, end your text response with <<INTENT:${intent_id}>>.",
  inputSchema: z.object({
    path: z
      .string()
      .min(3)
      .max(400)
      .describe(
        "Vault-relative path ending in .md (e.g. `03 - Main Notes/Journal/2026-06-03.md`). No leading slash.",
      ),
    content: z
      .string()
      .min(1)
      .max(20_000)
      .describe(
        "Full proposed file content. Keep it intentionally minimal — Yen edits after approve.",
      ),
    rationale: z
      .string()
      .describe(
        "One sentence explaining WHY this file should exist. Shown verbatim on the approval card.",
      ),
    importance: ImportanceSchema,
    evidence: z.array(EvidenceSchema).default([]),
  }),
  execute: async ({ path, content, rationale, importance, evidence }) => {
    const intent = await createIntent({
      kind: "file_create",
      proposed_by: "duffy",
      rationale,
      evidence: (evidence ?? []) as EvidenceRef[],
      importance: importance as Importance,
      payload: { path, content, rationale },
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      reminder: SENTINEL_REMINDER(intent.id),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  propose_edit_file                                                         */
/* -------------------------------------------------------------------------- */

export const proposeEditFile = tool({
  description:
    "Propose an edit to an EXISTING vault file. You must supply `old_text` as a verbatim substring that appears EXACTLY ONCE in the file (otherwise approve will fail). `new_text` replaces it. Use for surgical edits — rewriting a paragraph, fixing a heading, swapping a phrase. For wholesale rewrites or new sections, prefer proposing a sequence of small edits instead of one big one. End your text response with <<INTENT:${intent_id}>>.",
  inputSchema: z.object({
    path: z.string().min(3).max(400),
    old_text: z
      .string()
      .min(3)
      .max(8_000)
      .describe(
        "EXACT substring from the existing file. Copy verbatim from read_vault_file — do NOT paraphrase or summarise. Must match exactly once.",
      ),
    new_text: z
      .string()
      .max(8_000)
      .describe("Replacement text. Empty string deletes the old_text region."),
    rationale: z.string(),
    importance: ImportanceSchema,
    evidence: z.array(EvidenceSchema).default([]),
  }),
  execute: async ({
    path,
    old_text,
    new_text,
    rationale,
    importance,
    evidence,
  }) => {
    const intent = await createIntent({
      kind: "file_edit",
      proposed_by: "duffy",
      rationale,
      evidence: (evidence ?? []) as EvidenceRef[],
      importance: importance as Importance,
      payload: { path, old_text, new_text, rationale },
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      reminder: SENTINEL_REMINDER(intent.id),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  propose_todo                                                              */
/* -------------------------------------------------------------------------- */

export const proposeTodo = tool({
  description:
    "Propose a structured todo plan. On approve, items are appended to `05 - Queue/Duffy Todo Inbox.md` (created if absent), each as a checkbox line. Use when Yen describes work that splits into 2+ concrete next steps. Don't use for vague aspirations — that's an intention (propose_observation with isIntention=true). End your text response with <<INTENT:${intent_id}>>.",
  inputSchema: z.object({
    title: z.string().min(2).max(80).describe("One-line plan title."),
    items: z
      .array(
        z.object({
          text: z.string().min(2).max(200),
          category: z.string().max(40).optional(),
        }),
      )
      .min(1)
      .max(20),
    rationale: z.string(),
    importance: ImportanceSchema,
  }),
  execute: async ({ title, items, rationale, importance }) => {
    const intent = await createIntent({
      kind: "todo_plan",
      proposed_by: "duffy",
      rationale,
      evidence: [],
      importance: importance as Importance,
      payload: {
        title,
        items: items as TodoPlanItem[],
        rationale,
      },
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      reminder: SENTINEL_REMINDER(intent.id),
    };
  },
});
