/**
 * Stale intention nudge cron — Slice 8 B · 醒提主動.
 *
 * Strategy:
 *   - Polls every 6 hours (cheap; LLM only called when a nudge is due).
 *   - Once per local day (after NUDGE_HOUR), scan observations with an
 *     open or in_progress intention whose `last_touched_at` is older than
 *     STALE_DAYS. Skip any that already have a pending nudge intent.
 *   - For up to MAX_NUDGES_PER_DAY candidates, ask Duffy's LLM to draft a
 *     short nudge message and create a Pending observation intent (kind:
 *     "observation", payload.nudge_for = sourceObservation.id). Yen sees
 *     it next time he opens chat / Page B.
 *
 * Gate to avoid spam:
 *   - Per-day cap (MAX_NUDGES_PER_DAY).
 *   - Skip if there's already a pending nudge for the same source.
 *   - Approving a nudge calls touchIntention(), pushing the source's
 *     last_touched_at to now → leaves the stale cohort for another N days.
 *
 * Disable with env `NUDGE_CRON_DISABLED=1`.
 *
 * Hooked into Next.js via `instrumentation.ts` so it starts at server boot.
 */

import { generateText } from "ai";
import { hasAnyLLMKey, pickModel } from "@/lib/ai/model";
import { createIntent, listIntents } from "@/lib/agent/storage/intents";
import { listIntentionObservations } from "@/lib/agent/storage/observations";
import type {
  EvidenceRef,
  Observation,
  ObservationPayload,
} from "@/lib/agent/storage/types";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STALE_DAYS = 7;
const NUDGE_HOUR = 9; // local; only fire once-per-day after 09:00
const MAX_NUDGES_PER_DAY = 2;

const NUDGE_SYSTEM = `You are Duffy, drafting a short nudge to Yen about a commitment he made that has gone untouched for a while.

You'll be given ONE source observation (title + body + when Yen first said it + what he literally said). Write a nudge with this shape:

Output JSON ONLY (no fences, no prose):
{
  "title": "string — 6-14 zh chars summarising what the nudge points at",
  "body":  "string — 1-2 sentences zh, present tense, no scolding, no 'I noticed'. Direct.",
  "rationale": "string — 1 sentence zh explaining why you raise this now"
}

Tone rules:
- Traditional Chinese (Taiwan).
- Quote Yen's source_text (if given) as evidence that this was HIS commitment, not yours.
- Do NOT use 'you should' / '建議你' / '記得'. Use 'X 那件事...' / '上次你說的...'.
- One question or one nudge — not both.
- Do NOT propose new work. This is reminding of OLD work.`;

type State = {
  started: boolean;
  timer: NodeJS.Timeout | null;
  lastFiredDate: string | null; // YYYY-MM-DD local
};

const state: State = {
  started: false,
  timer: null,
  lastFiredDate: null,
};

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isStale(obs: Observation, nowMs: number): boolean {
  const i = obs.intention;
  if (!i) return false;
  if (i.status !== "open" && i.status !== "in_progress") return false;
  return nowMs - i.last_touched_at >= STALE_DAYS * 86_400_000;
}

async function pendingNudgeSources(): Promise<Set<string>> {
  const pending = await listIntents({ status: "pending", kind: "observation" });
  const out = new Set<string>();
  for (const i of pending) {
    const p = i.payload as ObservationPayload;
    if (p.nudge_for) out.add(p.nudge_for);
  }
  return out;
}

async function draftNudge(source: Observation): Promise<{
  title: string;
  body: string;
  rationale: string;
} | null> {
  const ctx = [
    `# Source observation`,
    `id: ${source.id}`,
    `title: ${source.title}`,
    `body: ${source.body}`,
    `first_noted_at: ${new Date(source.created_at).toLocaleDateString("zh-TW")}`,
    source.intention?.source_text
      ? `yen_said_verbatim: "${source.intention.source_text}"`
      : `(no verbatim quote available)`,
    source.intention?.target_date
      ? `target_date: ${new Date(source.intention.target_date).toLocaleDateString("zh-TW")}`
      : "(no target date set)",
    `last_touched_days_ago: ${Math.floor(
      (Date.now() - (source.intention?.last_touched_at ?? source.created_at)) /
        86_400_000,
    )}`,
  ].join("\n");

  try {
    const result = await generateText({
      model: pickModel(),
      system: NUDGE_SYSTEM,
      prompt: ctx,
    });
    const trimmed = result.text
      .trim()
      .replace(/^```(json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    return JSON.parse(trimmed) as {
      title: string;
      body: string;
      rationale: string;
    };
  } catch (e) {
    console.error("[nudge-cron] draftNudge failed:", e);
    return null;
  }
}

async function tryFire(): Promise<void> {
  if (!hasAnyLLMKey()) return;
  const now = new Date();
  if (now.getHours() < NUDGE_HOUR) return;
  const today = localDateStr(now);
  if (state.lastFiredDate === today) return;

  const nowMs = now.getTime();
  const all = await listIntentionObservations();
  const stale = all.filter((o) => isStale(o, nowMs));
  if (stale.length === 0) {
    state.lastFiredDate = today;
    return;
  }

  const alreadyPending = await pendingNudgeSources();
  const candidates = stale
    .filter((o) => !alreadyPending.has(o.id))
    .sort((a, b) => {
      // Prefer importance high → medium → low, then oldest last_touched_at
      const impOrder = { high: 0, medium: 1, low: 2 } as const;
      const da = impOrder[a.importance] - impOrder[b.importance];
      if (da !== 0) return da;
      return (
        (a.intention?.last_touched_at ?? a.created_at) -
        (b.intention?.last_touched_at ?? b.created_at)
      );
    })
    .slice(0, MAX_NUDGES_PER_DAY);

  if (candidates.length === 0) {
    state.lastFiredDate = today;
    return;
  }

  console.log(
    `[nudge-cron] firing ${candidates.length} nudge(s) for ${today}`,
  );

  for (const source of candidates) {
    const draft = await draftNudge(source);
    if (!draft) continue;
    const daysOld = Math.floor(
      (nowMs - (source.intention?.last_touched_at ?? source.created_at)) /
        86_400_000,
    );
    await createIntent({
      kind: "observation",
      proposed_by: "duffy",
      rationale: draft.rationale,
      importance: "medium",
      evidence: [{ kind: "observation", id: source.id }] as EvidenceRef[],
      payload: {
        title: draft.title,
        body: draft.body,
        nudge_for: source.id,
      },
    });

    // 方向 2 收尾 — surface the nudge as a macOS notification too.
    // maybeNotify checks the opt-in flag itself.
    try {
      const { maybeNotify } = await import("@/lib/agent/notifications");
      void maybeNotify({
        title: draft.title,
        body: `${daysOld} 天沒動 — ${draft.body.slice(0, 80)}`,
        subtitle: "Duffy 醒提",
      });
    } catch {
      /* nice-to-have */
    }

    // Telegram push for the same nudge.
    try {
      const { getTrustConfig } = await import("@/lib/agent/storage/trust-config");
      const { sendTelegram } = await import("@/lib/agent/telegram");
      const cfg = await getTrustConfig();
      if (
        cfg.telegram_enabled &&
        cfg.telegram_bot_token &&
        cfg.telegram_chat_id
      ) {
        void sendTelegram({
          token: cfg.telegram_bot_token,
          chat_id: cfg.telegram_chat_id,
          text: `🔔 醒提 · ${draft.title}\n${daysOld} 天沒動\n\n${draft.body}`,
        });
      }
    } catch {
      /* nice-to-have */
    }
  }

  state.lastFiredDate = today;
}

/** Start the cron loop. Safe to call multiple times — only starts once. */
export function startNudgeCron(): void {
  if (state.started) return;
  if (process.env.NUDGE_CRON_DISABLED === "1") {
    console.log("[nudge-cron] disabled via NUDGE_CRON_DISABLED=1");
    return;
  }
  state.started = true;
  // Fire once on boot to catch up if we missed the morning slot.
  void tryFire();
  state.timer = setInterval(() => {
    void tryFire();
  }, POLL_INTERVAL_MS);
  console.log(
    `[nudge-cron] started; poll every ${POLL_INTERVAL_MS / 3_600_000}h, stale=${STALE_DAYS}d, max/day=${MAX_NUDGES_PER_DAY}`,
  );
}
