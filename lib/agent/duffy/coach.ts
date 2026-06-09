/**
 * Coach — generates the "今天 Duffy 想跟你說" card shown at the top of Page B.
 *
 * Inputs:
 *   - Current silhouette (Duffy's portrait of Yen)
 *   - Current week summary (this week's snapshot)
 *   - Recent HIGH-importance observations (last 14 days, unread first)
 *   - Recent attention snapshot (live)
 *
 * Output: a short coach message (1-3 sentences) Yen reads as the first
 * thing on Page B. Cached for 1 hour to avoid burning tokens every page open.
 *
 * Cache bypass: `?refresh=1` on the route forces regeneration. Cache also
 * busts automatically when a new observation / silhouette / summary lands
 * (handled by callers via `bustCoachCache()`).
 */

import { generateText } from "ai";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasAnyLLMKey, pickModel } from "@/lib/ai/model";
import {
  getCurrentSilhouette,
  renderSilhouetteForPrompt,
} from "@/lib/agent/storage/silhouettes";
import {
  getCurrentWeekSummary,
  renderSummaryForPrompt,
} from "@/lib/agent/storage/summaries";
import { listObservations } from "@/lib/agent/storage/observations";
import { listIntents } from "@/lib/agent/storage/intents";
import { buildAttention } from "@/lib/vault/attention-data";
import type { ObservationPayload } from "@/lib/agent/storage/types";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const CACHE_FILE = join(CACHE_DIR, "coach.json");

type CoachCard = {
  message: string;
  generated_at: number;
  has_high_unread: boolean;
  high_unread_count: number;
  /** Slice 8: count of pending stale-intention nudges Yen hasn't decided on. */
  pending_nudge_count: number;
  // For UI provenance / debug
  used: {
    silhouette_version: number | null;
    summary_week: string | null;
    observations_count: number;
  };
};

let cached: CoachCard | null = null;
/** Inflight hydrate promise — subsequent callers piggy-back on the same
 *  await rather than racing past it. 2026-06-09 fix: previous code used a
 *  bare `hydrateAttempted` flag, so concurrent callers got `if (true)
 *  return` immediately while the first call's fs.readFile was still
 *  pending → cached stayed null → unnecessary LLM call (or hang). */
let hydratePromise: Promise<void> | null = null;

async function hydrateFromDisk(): Promise<void> {
  if (cached) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw) as CoachCard;
      if (
        parsed &&
        typeof parsed.generated_at === "number" &&
        typeof parsed.message === "string"
      ) {
        cached = parsed;
      }
    } catch {
      /* no cache file or unparseable — fine, we'll regenerate */
    }
  })();
  return hydratePromise;
}

async function writeToDisk(card: CoachCard): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(card, null, 2), "utf8");
  } catch {
    /* silent — disk write failure shouldn't break the page */
  }
}

export function bustCoachCache(): void {
  cached = null;
  // Best-effort: also remove disk cache so a fresh generation lands next call.
  void fs.unlink(CACHE_FILE).catch(() => {});
}

const COACH_SYSTEM = `You are Duffy, writing a short morning-style coach message to Yen for the top of his Yen Hub dashboard.

Constraints:
- 1 to 3 sentences. No more.
- Traditional Chinese (Taiwan).
- Reference ONE concrete observable signal (a number, an unread HIGH observation, a zone trend). Be specific.
- Tone: direct, present, no filler. No "great", no "as an AI". No "今天" if you already implied it.
- End with EITHER a question or an actionable suggestion — pick whichever lands stronger given the data.
- If there are HIGH-importance unread observations, mention the count and surface the most acute one verbatim or paraphrased.
- If there are pending stale-intention nudges (things Yen committed to but went quiet on), surface the freshest one — quote his own words from \`source_text\` if provided. Don't scold; just bring it back into view.
- If nothing is concerning, say so honestly without forcing concern.

Do NOT propose anything (you have no tools here). Just write the message.`;

export async function generateCoachCard(): Promise<CoachCard> {
  await hydrateFromDisk();
  if (cached && Date.now() - cached.generated_at < CACHE_TTL_MS) {
    return cached;
  }

  const [sil, sum, allObs, attention, pendingObsIntents] = await Promise.all([
    getCurrentSilhouette(),
    getCurrentWeekSummary(),
    listObservations({ agent: "duffy" }),
    buildAttention(7),
    listIntents({ status: "pending", kind: "observation" }),
  ]);

  const sinceMs = Date.now() - 14 * 86_400_000;
  const recent = allObs.filter((o) => o.created_at >= sinceMs);
  const highUnread = recent.filter(
    (o) => o.importance === "high" && !o.read_at,
  );

  // Slice 8 — pending stale-intention nudges.
  const pendingNudges = pendingObsIntents.filter((i) => {
    const p = i.payload as ObservationPayload;
    return Boolean(p.nudge_for);
  });
  const obsById = new Map(allObs.map((o) => [o.id, o] as const));

  const noKey = !hasAnyLLMKey();
  let message: string;
  if (noKey) {
    // Fallback when no LLM key — write a deterministic message so Page B
    // still has SOMETHING. Honest about being non-LLM.
    if (pendingNudges.length) {
      const first = pendingNudges[0].payload as ObservationPayload;
      message = `（無 LLM key）${pendingNudges.length} 則醒提待處理，最近一則：${first.title}。`;
    } else if (highUnread.length) {
      message = `（無 LLM key）你有 ${highUnread.length} 則高重要觀察未讀，最近一則：${highUnread[0].title}。`;
    } else {
      message = "（無 LLM key）目前沒有未讀的高重要觀察。";
    }
  } else {
    const topZone = [...attention.zones]
      .filter((z) => z.unit === "file")
      .sort((a, b) => (b.hoardRatio ?? 0) - (a.hoardRatio ?? 0))[0];
    const ctxParts: string[] = [];
    if (sil) ctxParts.push(renderSilhouetteForPrompt(sil));
    else ctxParts.push("# Silhouette\n_(not yet bootstrapped)_");
    if (sum) ctxParts.push(renderSummaryForPrompt(sum));
    else ctxParts.push("# Current week summary\n_(none yet)_");
    ctxParts.push(
      `# Recent HIGH-importance unread observations (last 14d)\n${
        highUnread.length === 0
          ? "_(none)_"
          : highUnread
              .slice(0, 5)
              .map(
                (o) =>
                  `- (${new Date(o.created_at).toLocaleDateString("zh-TW")}) ${o.title} — ${o.reason}`,
              )
              .join("\n")
      }`,
    );

    // Slice 8 — surface pending stale-intention nudges, freshest first.
    ctxParts.push(
      `# Pending stale-intention nudges\n${
        pendingNudges.length === 0
          ? "_(none)_"
          : pendingNudges
              .slice(0, 3)
              .map((i) => {
                const p = i.payload as ObservationPayload;
                const source = p.nudge_for ? obsById.get(p.nudge_for) : undefined;
                const quote = source?.intention?.source_text
                  ? ` — source_text: "${source.intention.source_text}"`
                  : "";
                return `- (${new Date(i.proposed_at).toLocaleDateString("zh-TW")}) ${p.title} — ${i.rationale}${quote}`;
              })
              .join("\n")
      }`,
    );
    if (topZone) {
      ctxParts.push(
        `# Top hoarding zone (last 7d)\n${topZone.zone}: added=${topZone.added}, opened=${topZone.opened}, ratio=${topZone.hoardRatio?.toFixed(1) ?? "n/a"}`,
      );
    }

    const result = await generateText({
      model: pickModel(),
      system: COACH_SYSTEM,
      prompt: ctxParts.join("\n\n---\n\n"),
    });
    message = result.text.trim();
  }

  cached = {
    message,
    generated_at: Date.now(),
    has_high_unread: highUnread.length > 0,
    high_unread_count: highUnread.length,
    pending_nudge_count: pendingNudges.length,
    used: {
      silhouette_version: sil?.version ?? null,
      summary_week: sum?.week ?? null,
      observations_count: allObs.length,
    },
  };
  void writeToDisk(cached); // fire-and-forget; persists across .app restarts
  return cached;
}
