/**
 * Summary cron — propose a weekly summary on Sunday evenings.
 *
 * Strategy:
 *   - Polls every 30 minutes (cheap; no LLM call until the gate clears).
 *   - Gate: today is Sunday AND local time >= 20:00 AND current week has no
 *     summary yet AND no pending summary intent for current week.
 *   - When gate clears → call LLM to draft a summary → create intent.
 *
 * Disable with env `SUMMARY_CRON_DISABLED=1`. Useful in dev when iterating.
 *
 * Hooked into Next.js via `instrumentation.ts` so it starts at server boot.
 */

import { generateText } from "ai";
import { hasAnyLLMKey, pickModel, modelLabel } from "@/lib/ai/model";
import { createIntent } from "@/lib/agent/storage/intents";
import { listIntents } from "@/lib/agent/storage/intents";
import { listObservations } from "@/lib/agent/storage/observations";
import {
  getCurrentSilhouette,
  renderSilhouetteForPrompt,
} from "@/lib/agent/storage/silhouettes";
import { getSummaryByWeek } from "@/lib/agent/storage/summaries";
import { buildAttention } from "@/lib/vault/attention-data";
import {
  type SummaryKeyNumber,
  isoWeek,
} from "@/lib/agent/storage/types";

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min

const SUMMARY_SYSTEM = `You are Duffy, drafting a weekly summary for Yen.

Output JSON ONLY (no fences, no prose) with these fields:
- "headline": string — one sentence in Traditional Chinese summarising the week's main story.
- "key_numbers": array of 3-7 objects, each { label, value, delta? }. label = short label (zh), value = the number (string), delta = optional vs-last-week change.
- "pattern": string — one paragraph (3-5 sentences) zh describing the pattern you see.
- "proposed_actions": array of 1-3 string suggestions for next week.
- "source_observations": array of observation IDs that most informed this summary.

Rules:
- Traditional Chinese (Taiwan).
- Ground every number in the provided context (attention zones, observations). Do not invent.
- "pattern" should connect the numbers into a story, not just restate them.
- "proposed_actions" should be specific and actionable (not "保持狀態").
- If the week has very little signal, say so honestly in pattern; don't pad.`;

type State = {
  started: boolean;
  timer: NodeJS.Timeout | null;
  lastFiredWeek: string | null;
};

const state: State = {
  started: false,
  timer: null,
  lastFiredWeek: null,
};

function shouldFireNow(now: Date): boolean {
  const dow = now.getDay(); // 0 = Sunday
  const hour = now.getHours();
  return dow === 0 && hour >= 20;
}

async function alreadyCoveredOrPending(week: string): Promise<boolean> {
  const existing = await getSummaryByWeek(week);
  if (existing) return true;
  const pending = await listIntents({ status: "pending", kind: "summary" });
  return pending.some(
    (i) =>
      // narrow via discriminator: summary payload has `week`
      i.kind === "summary" &&
      (i.payload as { week?: string }).week === week,
  );
}

async function tryFire(): Promise<void> {
  if (!hasAnyLLMKey()) {
    console.log("[summary-cron] no llm key; skipping");
    return;
  }
  const now = new Date();
  if (!shouldFireNow(now)) return;
  const week = isoWeek(now);
  if (state.lastFiredWeek === week) return;
  if (await alreadyCoveredOrPending(week)) {
    state.lastFiredWeek = week;
    return;
  }

  console.log(`[summary-cron] firing for ${week}`);
  try {
    await proposeWeeklySummary(week);
    state.lastFiredWeek = week;
  } catch (e) {
    console.error("[summary-cron] propose failed:", e);
  }
}

export async function proposeWeeklySummary(week: string): Promise<void> {
  const [sil, obs, attention] = await Promise.all([
    getCurrentSilhouette(),
    listObservations({ agent: "duffy", since: Date.now() - 7 * 86_400_000 }),
    buildAttention(7),
  ]);

  const ctxParts: string[] = [];
  if (sil) ctxParts.push(renderSilhouetteForPrompt(sil));

  ctxParts.push(
    `# Observations this week (${obs.length})\n${
      obs
        .slice(0, 30)
        .map(
          (o) =>
            `- ${o.id} (${o.importance}) ${o.title} — ${o.reason}`,
        )
        .join("\n") || "_(none)_"
    }`,
  );

  ctxParts.push(
    `# Attention zones (last 7 days)\n${attention.zones
      .map(
        (z) =>
          `- ${z.zone}: total=${z.total}, added=${z.added}, opened=${z.opened}, ratio=${z.hoardRatio?.toFixed(2) ?? "n/a"}`,
      )
      .join("\n")}`,
  );

  ctxParts.push(
    `# Actively reading\n${
      attention.library.activelyReading
        .slice(0, 5)
        .map(
          (b) =>
            `- ${b.displayTitle ?? b.name} (opened ${b.openedChapters} ch)`,
        )
        .join("\n") || "_(none)_"
    }`,
  );

  ctxParts.push(`# Week label\n${week}`);

  const result = await generateText({
    model: pickModel(),
    system: SUMMARY_SYSTEM,
    prompt: ctxParts.join("\n\n---\n\n"),
  });
  // Slice 元能力 #1 — record usage.
  try {
    const { recordTokenUsage } = await import(
      "@/lib/agent/storage/token-usage"
    );
    await recordTokenUsage({
      call_site: "summary-cron",
      model: modelLabel(),
      usage: result.usage,
      ref: week,
    });
  } catch {
    /* swallow */
  }

  // Parse JSON, tolerate code fence.
  const trimmed = result.text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(trimmed) as {
    headline: string;
    key_numbers: SummaryKeyNumber[];
    pattern: string;
    proposed_actions: string[];
    source_observations: string[];
  };

  await createIntent({
    kind: "summary",
    proposed_by: "duffy",
    rationale: `Weekly summary for ${week} (auto-proposed by cron)`,
    importance: "medium",
    payload: {
      week,
      headline: parsed.headline,
      key_numbers: parsed.key_numbers,
      pattern: parsed.pattern,
      proposed_actions: parsed.proposed_actions ?? [],
      source_observations: parsed.source_observations ?? [],
    },
  });
}

/** Start the cron loop. Safe to call multiple times — only starts once. */
export function startSummaryCron(): void {
  if (state.started) return;
  if (process.env.SUMMARY_CRON_DISABLED === "1") {
    console.log("[summary-cron] disabled via SUMMARY_CRON_DISABLED=1");
    return;
  }
  state.started = true;
  // Fire once on boot to catch up if we missed Sunday.
  void tryFire();
  state.timer = setInterval(() => {
    void tryFire();
  }, POLL_INTERVAL_MS);
  console.log(
    `[summary-cron] started; poll every ${POLL_INTERVAL_MS / 60_000} min`,
  );
}
