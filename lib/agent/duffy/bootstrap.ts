/**
 * Bootstrap — generate the first version of Yen's silhouette from existing
 * signals (observations, attention, todos). Produces a `silhouette_update`
 * Intent with field="full"; user approves via the standard chat intent card.
 *
 * Called from /api/silhouette/bootstrap (POST). Idempotent if a silhouette
 * already exists — returns null and lets caller surface "already bootstrapped".
 */

import { generateText } from "ai";
import { hasAnyLLMKey, pickModel } from "@/lib/ai/model";
import { getCurrentSilhouette } from "@/lib/agent/storage/silhouettes";
import { listObservations } from "@/lib/agent/storage/observations";
import { createIntent } from "@/lib/agent/storage/intents";
import { buildAttention } from "@/lib/vault/attention-data";
import { scanTodos } from "@/lib/vault/todos";
import type { Intent } from "@/lib/agent/storage/types";

const BOOTSTRAP_SYSTEM = `You are Duffy, drafting the FIRST version of a "Silhouette of Yen" document.

The silhouette is your portrait of Yen — what you understand about him so far. It has 5 fixed sections:

1. **Identity** — who Yen is, what he does, big-picture context.
2. **Style** — his preferred communication / work style.
3. **Values** — what he cares about (and explicitly doesn't).
4. **Boundaries** — what he rejects, what's off-limits.
5. **Priorities** — what he's focused on right now and long-term.

Rules for this first draft:
- Traditional Chinese (Taiwan).
- Be honest about uncertainty. This is v1; you barely know him. Use phrases like "目前看起來…", "尚不確定", "需要更多資料". Don't fake confidence.
- Ground each section in concrete signals from the context provided (observation history, attention zones, todos). If you have no signal for a section, say so explicitly.
- Each section: 2-5 sentences. No filler.
- DO NOT make up traits — only state what the data supports.

Output: a JSON object with exactly these 5 string keys: identity, style, values, boundaries, priorities. Each value is plain text (not markdown). Output JSON ONLY — no surrounding prose, no code fences, no explanation.`;

/**
 * Result: the created intent (or null if a silhouette already exists).
 * Caller handles the "already bootstrapped" case.
 */
export async function bootstrapSilhouette(): Promise<Intent | null> {
  if (!hasAnyLLMKey()) {
    throw new Error("no llm key — set KIMI_API_KEY or ANTHROPIC_API_KEY");
  }

  const existing = await getCurrentSilhouette();
  if (existing) return null;

  const [obs, attention, todos] = await Promise.all([
    listObservations({ agent: "duffy" }),
    buildAttention(30),
    scanTodos(50, "queue"),
  ]);

  const obsBlock =
    obs.length === 0
      ? "_(no past observations yet)_"
      : obs
          .slice(0, 50)
          .map(
            (o, i) =>
              `${i + 1}. [${new Date(o.created_at).toISOString().slice(0, 10)}] (${o.importance}) ${o.title} — ${o.reason}`,
          )
          .join("\n");

  const zoneBlock = attention.zones
    .filter((z) => z.added > 0 || z.opened > 0 || z.total > 0)
    .map(
      (z) =>
        `- ${z.zone}: total=${z.total}, added(30d)=${z.added}, opened(30d)=${z.opened}, hoardRatio=${z.hoardRatio?.toFixed(2) ?? "n/a"}`,
    )
    .join("\n");

  const readingBlock =
    attention.library.activelyReading.length === 0
      ? "_(none)_"
      : attention.library.activelyReading
          .slice(0, 10)
          .map(
            (b) =>
              `- ${b.displayTitle ?? b.name} (opened ${b.openedChapters} chapters)`,
          )
          .join("\n");

  const todoBlock =
    todos.length === 0
      ? "_(no open todos)_"
      : todos
          .slice(0, 30)
          .map((t) => `- [${t.category}] ${t.text}`)
          .join("\n");

  const userPrompt = `# Past observations (newest first)

${obsBlock}

# Attention by zone (last 30 days)

${zoneBlock}

# Actively reading

${readingBlock}

# Open todos (top 30)

${todoBlock}

---

Draft Yen's silhouette v1 as JSON.`;

  const result = await generateText({
    model: pickModel(),
    system: BOOTSTRAP_SYSTEM,
    prompt: userPrompt,
  });

  // Parse the JSON robustly — LLM may wrap in code fence despite instruction.
  let parsed: Record<string, string>;
  const trimmed = result.text.trim().replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
  try {
    parsed = JSON.parse(trimmed) as Record<string, string>;
  } catch (e) {
    throw new Error(
      `bootstrap: LLM did not return parseable JSON. raw="${result.text.slice(0, 200)}…" err=${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const requiredKeys = [
    "identity",
    "style",
    "values",
    "boundaries",
    "priorities",
  ] as const;
  for (const k of requiredKeys) {
    if (typeof parsed[k] !== "string") {
      throw new Error(`bootstrap: missing field "${k}" in LLM JSON output`);
    }
  }

  const intent = await createIntent({
    kind: "silhouette_update",
    proposed_by: "duffy",
    rationale:
      "第一次草擬剪影 v1。基於現有 observations、近 30 天 vault attention、開放 todos。Confidence 低,需要 Yen 多次互動才會精準。",
    importance: "medium",
    payload: {
      field: "full",
      new_value: JSON.stringify({
        identity: parsed.identity,
        style: parsed.style,
        values: parsed.values,
        boundaries: parsed.boundaries,
        priorities: parsed.priorities,
      }),
      reason:
        "第一版,從現有訊號草擬。許多欄位 confidence 低,之後會 propose update。",
      confidence: "low",
    },
  });

  return intent;
}
