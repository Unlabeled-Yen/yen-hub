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
  TrustTier,
} from "@/lib/agent/storage/types";

/**
 * Slice α (2026-06-15) — Duffy Workspace path-based L0.
 *
 * Any file_create / file_edit whose path is under `06 - AI Data/Duffy Workspace/`
 * is Duffy's sandbox: it auto-executes instead of going through approve queue.
 * Path-based, not kind-based — the same tools handle vault main area (gated)
 * and sandbox (auto), the path decides.
 *
 * Why path-based not new tools: introducing a separate `duffy_write_sandbox`
 * tool would require Duffy to choose which tool to call. Reusing the existing
 * propose_* tools and gating by path keeps the LLM-facing surface unchanged —
 * Duffy just learns "write to your workspace = auto-executes" from the prompt.
 *
 * Sentinel still emitted but UI knows to skip rendering an approval card for
 * auto-approved intents (createIntent flips status to "approved" before the
 * client ever sees it). See prompt.ts autonomy section.
 */
const DUFFY_WORKSPACE_PREFIX = "06 - AI Data/Duffy Workspace/";

function isInDuffyWorkspace(path: string): boolean {
  // Normalise: strip leading slash, no '..' escapes (defense-in-depth; the
  // materialiser also has a path-traversal guard).
  const p = path.replace(/^\/+/, "");
  if (p.includes("..")) return false;
  return p.startsWith(DUFFY_WORKSPACE_PREFIX);
}

function tierForPath(path: string): TrustTier | undefined {
  return isInDuffyWorkspace(path) ? "L0" : undefined;
}

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
    "Create a NEW Markdown file in Yen's vault. The file MUST NOT already exist. Behavior depends on path:\n" +
    "  • Path under `06 - AI Data/Duffy Workspace/` — your sandbox. AUTO-EXECUTES, no approval. Sentinel optional (UI skips card). Use freely for your notes, findings, scratch work.\n" +
    "  • Any other path — Yen's main vault. Goes through propose/approve queue; nothing lands until he taps approve. End your text response with <<INTENT:${intent_id}>>.\n" +
    "Use when something concrete needs a new .md — your own workspace notes (just do it) or a starter file in Yen's vault (gated).",
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
    const trust_tier = tierForPath(path);
    const intent = await createIntent({
      kind: "file_create",
      proposed_by: "duffy",
      rationale,
      evidence: (evidence ?? []) as EvidenceRef[],
      importance: importance as Importance,
      payload: { path, content, rationale },
      trust_tier,
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      // Slice α: sandbox writes auto-execute → no sentinel needed.
      reminder:
        intent.status === "approved"
          ? "sandbox write executed — no sentinel needed, keep going if more steps planned"
          : SENTINEL_REMINDER(intent.id),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  propose_edit_file                                                         */
/* -------------------------------------------------------------------------- */

export const proposeEditFile = tool({
  description:
    "Edit an EXISTING vault file. Supply `old_text` as a verbatim substring that appears EXACTLY ONCE in the file (otherwise the write fails). `new_text` replaces it. Behavior depends on path:\n" +
    "  • Path under `06 - AI Data/Duffy Workspace/` — your sandbox. AUTO-EXECUTES, no approval. Sentinel optional.\n" +
    "  • Any other path — Yen's main vault. Goes through propose/approve queue. End text response with <<INTENT:${intent_id}>>.\n" +
    "Use for surgical edits — rewriting a paragraph, fixing a heading, swapping a phrase. For wholesale rewrites prefer a sequence of small edits.",
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
    const trust_tier = tierForPath(path);
    const intent = await createIntent({
      kind: "file_edit",
      proposed_by: "duffy",
      rationale,
      evidence: (evidence ?? []) as EvidenceRef[],
      importance: importance as Importance,
      payload: { path, old_text, new_text, rationale },
      trust_tier,
    });
    return {
      intent_id: intent.id,
      status: intent.status,
      reminder:
        intent.status === "approved"
          ? "sandbox edit executed — no sentinel needed, keep going if more steps planned"
          : SENTINEL_REMINDER(intent.id),
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
