/**
 * Self-correction gate (PRD v3 A1, 造法二 — 2026-06-16).
 *
 * The structural, non-nudge half of "ground before claiming": a deterministic
 * detector for the pattern «Duffy said it CAN'T do something, without having
 * looked anything up this turn». It does NOT rely on Duffy remembering to
 * self-check — pure code on the response text + this turn's tool trace.
 *
 * Streaming reality (see agent.ts): by the time the final text exists, it has
 * already streamed to the user — we can't retract it without killing the
 * typing UX Yen asked for, nor force an in-stream reflection step without
 * fighting the SDK's agentic loop. So the honest, low-risk form is
 * NEXT-TURN correction: on detection we set a one-shot flag; the next turn's
 * system prompt opens with a reminder to search before re-claiming. Weaker
 * than same-turn, but clean and observable. Upgrade to a pre-emptive gate
 * (造法一) only if "wrong claim flashes once" proves harmful.
 */

/** First-person capability/tool denials. Kept tight, leaning toward
 *  tool/ability claims, NOT general inability — 寧可少攔也別狂誤攔. */
const DENIAL_PHRASES = [
  "沒有這個工具",
  "沒有這樣的工具",
  "沒有相關工具",
  "我沒有這個功能",
  "我沒有權限",
  "我無法存取",
  "我無法讀取",
  "我無法執行",
  "我無法查",
  "我辦不到",
  "我做不到",
  "我沒辦法",
] as const;

/** Read/lookup tools. If ANY of these was called this turn, Duffy "looked" —
 *  so a denial is grounded and we don't nag. Broad on purpose (fewer false
 *  nags); excludes pure-utility tools like get_current_time. */
const READ_TOOLS = new Set<string>([
  "search_observations",
  "read_observations_history",
  "read_conversation_history",
  "search_old_summaries",
  "read_attention_state",
  "read_todos",
  "search_vault",
  "read_vault_file",
  "list_skills",
  "use_skill",
  "web_search",
  "web_extract",
  "read_external_file",
  "list_external_dir",
  "read_develop_file",
  "read_learning_ai_file",
  "list_develop_dir",
  "list_learning_ai_dir",
  "list_pending_intents",
  "list_schedules",
  "read_action_status",
]);

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

/**
 * Did Duffy claim it can't do something WITHOUT looking anything up this turn?
 * Pure + unit-testable. The whole point of A1: this fires on structure, not on
 * Duffy remembering to be honest.
 */
export function detectUnsearchedDenial(
  text: string,
  searchedThisTurn: boolean,
): boolean {
  if (searchedThisTurn) return false;
  return DENIAL_PHRASES.some((p) => text.includes(p));
}

/* -------------------------------------------------------------------------- */
/*  One-shot per-conversation flag (in-memory; transient by design)           */
/* -------------------------------------------------------------------------- */
// Chat turns for one conversation all run in the route-side bundle, so an
// in-memory flag survives across turns within the running server. Lost on
// restart — fine; it's a transient nudge, not durable state.
const pending = new Set<string>();

export function markPendingSelfCheck(convoId: string): void {
  pending.add(convoId);
}

/** Returns true once if a self-check is pending for this convo, then clears. */
export function consumePendingSelfCheck(convoId: string): boolean {
  if (!pending.has(convoId)) return false;
  pending.delete(convoId);
  return true;
}

export const SELF_CHECK_REMINDER =
  "# ⚠️ 一次性自我修正提醒（系統自動加，本輪用完即移除）\n\n" +
  "上一輪你回答時說了「我沒有 / 辦不到 / 沒這個工具」之類的**能力否定**，" +
  "但那一輪你**沒有呼叫任何搜尋/讀取工具**就下了這個結論——違反 SOUL 的「ground before claiming」。\n\n" +
  "若這次延續同一個問題：**先用搜尋/讀取工具查證**" +
  "（search_observations / read_vault_file / search_vault / list_* / read_action_status 等），" +
  "再決定是不是真的辦不到。查完若確實做不到，就誠實說「查過了，確實沒有」。\n\n---\n\n";
