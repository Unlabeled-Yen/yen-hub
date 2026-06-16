/**
 * Schedule actions — Slice 11.
 *
 * Each handler runs when the scheduler decides a Schedule is due. The
 * handler's job is NOT to mutate Yen's world directly — it's to surface
 * a finding (as an Observation or a propose-observation intent) so the
 * propose-approve flow stays in charge.
 *
 * v1 ships two action kinds. Two more (observation_review, custom_prompt)
 * land after Slice 8.7B trust-tier so they can be governed.
 */

import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { join } from "node:path";
import { createObservationFromIntent } from "@/lib/agent/storage/observations";
import { createIntent } from "@/lib/agent/storage/intents";
import { decideIntent } from "@/lib/agent/storage/intents";
import { vaultPath } from "@/lib/vault/reader";
import type {
  Schedule,
  ObservationPayload,
} from "@/lib/agent/storage/types";

const exec = promisify(execCb);

/** Common shape: each action records an observation about its finding. */
type Finding = {
  title: string;
  body: string;
  importance: "high" | "medium" | "low";
};

/* -------------------------------------------------------------------------- */
/*  git_unpushed_check                                                         */
/* -------------------------------------------------------------------------- */

type GitCheckPayload = { repos: string[] };

async function gitUnpushedCheck(
  s: Schedule,
): Promise<Finding | null> {
  const payload = s.action_payload as GitCheckPayload;
  if (!Array.isArray(payload.repos) || payload.repos.length === 0) return null;

  const lines: string[] = [];
  for (const repoRel of payload.repos) {
    // repoRel may be absolute or vault-relative or home-relative
    const repoPath = repoRel.startsWith("/")
      ? repoRel
      : repoRel.startsWith("~/")
        ? repoRel.replace(/^~/, process.env.HOME ?? "")
        : join(vaultPath(), "..", repoRel);
    try {
      const { stdout: branch } = await exec(
        `git -C "${repoPath}" rev-parse --abbrev-ref HEAD`,
      );
      const br = branch.trim();
      // Unpushed: commits ahead of upstream
      let ahead = "0";
      try {
        const { stdout: aheadOut } = await exec(
          `git -C "${repoPath}" rev-list --count @{u}..HEAD`,
        );
        ahead = aheadOut.trim();
      } catch {
        /* no upstream */
      }
      // Dirty: uncommitted changes
      const { stdout: status } = await exec(
        `git -C "${repoPath}" status --porcelain`,
      );
      const dirty = status.trim().split("\n").filter(Boolean).length;

      if (parseInt(ahead, 10) > 0 || dirty > 0) {
        lines.push(
          `- ${repoRel} (${br}) — 未推 ${ahead} commits, 未提交 ${dirty} 檔`,
        );
      }
    } catch (e) {
      lines.push(
        `- ${repoRel} — 檢查失敗: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (lines.length === 0) return null;
  return {
    title: `Git 未推 / 未提交檢查 (${lines.length} repos)`,
    body: lines.join("\n"),
    importance: "medium",
  };
}

/* -------------------------------------------------------------------------- */
/*  vault_zone_check                                                           */
/* -------------------------------------------------------------------------- */

type VaultZoneCheckPayload = { zone: string; days_idle: number };

async function vaultZoneCheck(s: Schedule): Promise<Finding | null> {
  const payload = s.action_payload as VaultZoneCheckPayload;
  if (!payload.zone || !payload.days_idle) return null;

  // Lazy import to avoid pulling heavy attention-data at module load
  const { buildAttention } = await import("@/lib/vault/attention-data");
  const data = await buildAttention(Math.max(payload.days_idle, 7));
  const zone = data.zones.find((z) => z.zone === payload.zone);

  if (!zone) {
    return {
      title: `${payload.zone} zone 找不到`,
      body: `排程設定 zone="${payload.zone}"、但 attention 資料裡沒有此 zone。可能該 zone 在這段期間完全沒動、或拼字錯誤。`,
      importance: "low",
    };
  }

  if (zone.added === 0 && zone.opened === 0) {
    return {
      title: `${payload.zone} zone 已 ${payload.days_idle} 天無活動`,
      body: `近 ${payload.days_idle} 天 ${payload.zone} 沒有新檔、也沒有開啟。是否需要回頭看看？`,
      importance: "medium",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  reminder — Slice 11.1                                                      */
/* -------------------------------------------------------------------------- */

type ReminderPayload = { message: string };

async function reminderAction(s: Schedule): Promise<Finding | null> {
  const payload = s.action_payload as ReminderPayload;
  const message = (payload?.message ?? "").trim();
  if (!message) return null;

  // 方向 2 收尾 — fire macOS notification in parallel. maybeNotify
  // checks the opt-in flag itself and never throws.
  try {
    const { maybeNotify } = await import("@/lib/agent/notifications");
    void maybeNotify({
      title: s.name,
      body: message,
      subtitle: "Duffy 提醒",
    });
  } catch {
    /* notifications are nice-to-have */
  }

  // Telegram integration — push to user's bot if enabled. Same opt-in
  // posture as macOS notifications.
  try {
    const { getTrustConfig } = await import("@/lib/agent/storage/trust-config");
    const { sendTelegram } = await import("@/lib/agent/telegram");
    const cfg = await getTrustConfig();
    if (cfg.telegram_enabled && cfg.telegram_bot_token && cfg.telegram_chat_id) {
      void sendTelegram({
        token: cfg.telegram_bot_token,
        chat_id: cfg.telegram_chat_id,
        text: `⏰ ${s.name}\n${message}`,
      });
    }
  } catch {
    /* nice-to-have */
  }

  return {
    title: s.name,
    body: message,
    importance: "high",
  };
}

/* -------------------------------------------------------------------------- */
/*  journal_interview                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Phase 2a — nightly journal interview prompt.
 *
 * Fires 21:00 daily. Idempotent per-day: if today's journal file already
 * has interview_complete: true, the action surfaces a softer "今天已完成"
 * note instead of nagging twice. Otherwise it surfaces a high-importance
 * obs telling Yen to open the Duffy chat and say "開始日記訪談" — which
 * Duffy's prompt knows to expand into the interview flow (read 5 questions
 * from [[個人日記-題目設計]], walk through them, write today's file via
 * propose_new_file).
 *
 * Notification + UI-hint integration ship in Phase 2b. For now the obs
 * itself is the signal — it appears in the Page B observations strip with
 * high importance so it's visible.
 */
async function journalInterviewAction(s: Schedule): Promise<Finding | null> {
  const today = formatLocalDate(new Date());
  const journalRel = `07 - 個人日記/${today}.md`;

  // Idempotency: peek the file. If it exists with interview_complete: true,
  // a softer note. If it doesn't exist or isn't complete, the interview
  // hasn't happened yet today — surface the call-to-action.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const abs = path.join(vaultPath(), journalRel);
  let alreadyComplete = false;
  try {
    const content = await fs.readFile(abs, "utf8");
    // Cheap detection — frontmatter line, no YAML parser needed
    alreadyComplete = /interview_complete:\s*true/.test(content);
  } catch {
    /* file missing → not complete */
  }

  if (alreadyComplete) {
    return {
      title: "今天的日記已完成 ✓",
      body: `${today} 的訪談已寫入 ${journalRel}。明天 21:00 再見。`,
      importance: "low",
    };
  }

  // ask_first semantics (skill-anchored reminder, 2026-06-13).
  // OLD behavior auto-pushed Q1 — no consent buffer; if Yen was busy at
  // 21:00 the questions arrived anyway, and one-shot reminders fell back
  // to generic `reminder` (free-form text into conversation, context bleed).
  //
  // NEW behavior: ask "ready to start?", set a pending-skill marker, and
  // wait for an affirmative reply. The telegram-poller's pre-Duffy intercept
  // catches the reply, clears the marker, and only THEN pushes Q1. The
  // user's «好» / «開始» can no longer be hijacked by prior conversation.
  //
  // Opt out via action_payload.ask_first === false (preserves the
  // legacy fire-and-forget behavior for callers that want it).
  type Payload = { ask_first?: boolean };
  const askFirst = (s.action_payload as Payload)?.ask_first !== false;

  try {
    if (askFirst) {
      await maybeAskJournalInterviewOnTelegram(today, s.id);
    } else {
      await maybePushJournalInterviewToTelegram(today);
    }
  } catch (e) {
    console.warn("[journal_interview] telegram push failed:", e);
  }

  // macOS notification — let Yen know to look at Telegram (or Page B).
  try {
    const { maybeNotify } = await import("@/lib/agent/notifications");
    void maybeNotify({
      title: "🌙 日記訪談時間到了",
      body: askFirst
        ? `${today} · 回 Telegram「好」就開始`
        : `${today} · 已在 Telegram 開場（或開 Page B 看卡）`,
      subtitle: "Duffy",
    });
  } catch {
    /* notifications are nice-to-have */
  }

  const body = askFirst
    ? [
        "今天的日記訪談時間到了（5 題 / 約 5 分鐘）。",
        "",
        "Telegram 已經問你「現在可以嗎？」—— 回「好」就開始、「等等」我延後 30 分鐘。",
        "",
        "30 分鐘內沒回覆，提案會自動消失（不會在背後一直推題）。",
        `題目設計：[[個人日記-題目設計]] · 萃取規格：[[個人日記-萃取規格]]）`,
      ].join("\n")
    : [
        "今天的日記訪談時間到了（5 題 / 約 5 分鐘）。",
        "",
        "如果 Telegram 開著，Duffy 已在那邊問 Q1，直接回就好。",
        "否則：打開 Duffy 對話 → 對它說「開始日記訪談」。",
        "",
        `Duffy 會逐題問你、答完用 propose_new_file 寫進 ${journalRel}。`,
        "（題目設計：[[個人日記-題目設計]] · 萃取規格：[[個人日記-萃取規格]]）",
      ].join("\n");

  return {
    title: `日記訪談 · ${today}`,
    body,
    importance: "high",
  };
}

/** Send the consent prompt to Telegram and set a pending-skill marker.
 *  When Yen replies affirmatively, telegram-poller's intercept clears the
 *  marker and fires the actual Q1 push. */
async function maybeAskJournalInterviewOnTelegram(
  today: string,
  scheduleId: string,
): Promise<void> {
  const { getTrustConfig } = await import("@/lib/agent/storage/trust-config");
  const cfg = await getTrustConfig();
  if (
    !cfg.telegram_enabled ||
    !cfg.telegram_bot_token ||
    !cfg.telegram_chat_id
  ) {
    return;
  }
  const chat_id = cfg.telegram_chat_id;
  const { sendTelegram } = await import("@/lib/agent/telegram");
  const { appendTelegramMessage } = await import(
    "@/lib/agent/storage/telegram-chats"
  );
  const { setPendingSkillSession } = await import(
    "@/lib/agent/duffy/pending-skill-session"
  );

  const prompt = [
    "🌙 日記訪談時間到了。",
    "",
    `${today} 還沒寫。要現在開始嗎？（5 題 / 約 5 分鐘）`,
    "",
    "好 → 我現在開場 Q1",
    "等等 → 我把它延後（接下來告訴我延幾分鐘）",
  ].join("\n");

  await sendTelegram({
    token: cfg.telegram_bot_token!,
    chat_id,
    text: prompt,
  });
  await appendTelegramMessage(chat_id, {
    role: "assistant",
    text: prompt,
    ts: Date.now(),
  });
  await setPendingSkillSession({
    chatId: chat_id,
    skill: "journal_interview",
    source: "scheduler",
    scheduleId,
    context: { today },
  });
}

/** Called by the telegram-poller after Yen confirms a pending skill session.
 *  The poller is ALREADY inside withTelegramTurn(chat_id), so we MUST NOT
 *  re-enter the mutex here — it would deadlock (mutex is non-reentrant,
 *  see telegram-mutex.ts:26-32). Call the inner unlocked function. */
export async function runJournalInterviewNow(today: string): Promise<void> {
  const { getTrustConfig } = await import("@/lib/agent/storage/trust-config");
  const cfg = await getTrustConfig();
  if (
    !cfg.telegram_enabled ||
    !cfg.telegram_bot_token ||
    !cfg.telegram_chat_id
  ) {
    return;
  }
  await pushJournalInterviewToTelegramInner(cfg.telegram_chat_id, today, cfg);
}

/** Push the opening Q1 to Telegram by synthesising a user message
 *  「開始日記訪談」, running Duffy headless, and forwarding the reply.
 *  Behaves as a no-op when Telegram isn't fully configured. */
async function maybePushJournalInterviewToTelegram(today: string): Promise<void> {
  const { getTrustConfig } = await import("@/lib/agent/storage/trust-config");
  const cfg = await getTrustConfig();
  if (
    !cfg.telegram_enabled ||
    !cfg.telegram_bot_token ||
    !cfg.telegram_chat_id
  ) {
    return;
  }

  const chat_id = cfg.telegram_chat_id;
  const { withTelegramTurn } = await import("@/lib/agent/duffy/telegram-mutex");

  await withTelegramTurn(chat_id, () =>
    pushJournalInterviewToTelegramInner(chat_id, today, cfg),
  );
}

/** Inner unlocked function — must be called from within withTelegramTurn
 *  (or from a path that's already inside it, like the poller intercept). */
async function pushJournalInterviewToTelegramInner(
  chat_id: number,
  today: string,
  cfg: { telegram_bot_token?: string | null },
): Promise<void> {
  const {
    appendTelegramMessage,
    readTelegramHistory,
  } = await import("@/lib/agent/storage/telegram-chats");
    const { runDuffyHeadless } = await import("@/lib/agent/duffy/headless");
    const { sendTelegram } = await import("@/lib/agent/telegram");

    const opener = "開始日記訪談";

    // Read history BEFORE appending the synthetic user turn so we don't
    // duplicate it into the UI message list.
    const history = await readTelegramHistory(chat_id);
    await appendTelegramMessage(chat_id, {
      role: "user",
      text: opener,
      ts: Date.now(),
    });

    type UiMsg = {
      id: string;
      role: "user" | "assistant";
      parts: Array<{ type: "text"; text: string }>;
    };
    const uiMessages: UiMsg[] = history.map((m, i) => ({
      id: `tg-hist-${i}`,
      role: m.role,
      parts: [{ type: "text", text: m.text }],
    }));
    uiMessages.push({
      id: "tg-now",
      role: "user",
      parts: [{ type: "text", text: opener }],
    });

    const result = await runDuffyHeadless({
      // Cast is safe — UIMessage's narrowed `parts` union accepts text parts.
      messages: uiMessages as unknown as Parameters<typeof runDuffyHeadless>[0]["messages"],
      surface: "telegram",
    });

    if (!result.ok) {
      await sendTelegram({
        token: cfg.telegram_bot_token!,
        chat_id,
        text: `⚠️ 日記訪談開場失敗：${result.error}（可手動說「開始日記訪談」）`,
      });
      return;
    }

    // Persist full reply (mode tag included) for context continuity.
    await appendTelegramMessage(chat_id, {
      role: "assistant",
      text: result.text,
      ts: Date.now(),
    });

  const reply = stripModeTagForTelegram(result.text);
  await sendTelegram({
    token: cfg.telegram_bot_token!,
    chat_id,
    text: `🌙 日記訪談 · ${today}\n\n${reply}`,
  });
}

/** Mirrors telegram-poller's stripModeTag — extracted here to avoid a
 *  cross-import that would force a heavier dep cycle. Keep behavior in
 *  sync with telegram-poller.ts:38-47. */
function stripModeTagForTelegram(text: string): string {
  return text.replace(
    /^\s*\[(coach|do|watch|pair)(\s*\(locked\))?\]\s*\n+/i,
    "",
  );
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* -------------------------------------------------------------------------- */
/*  Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

const HANDLERS: Record<
  Schedule["action_kind"],
  (s: Schedule) => Promise<Finding | null>
> = {
  git_unpushed_check: gitUnpushedCheck,
  vault_zone_check: vaultZoneCheck,
  reminder: reminderAction,
  journal_interview: journalInterviewAction,
};

/** Run the action, materialise findings as observations.
 *  Returns the resulting observation id (if any). */
export async function runScheduleAction(s: Schedule): Promise<string | null> {
  const handler = HANDLERS[s.action_kind];
  if (!handler) {
    console.warn(`[schedule-action] no handler for ${s.action_kind}`);
    return null;
  }

  let finding: Finding | null = null;
  try {
    finding = await handler(s);
  } catch (e) {
    console.error(
      `[schedule-action] ${s.id} (${s.action_kind}) threw:`,
      e,
    );
    return null;
  }
  if (!finding) return null;

  // Surface as a self-approved observation — schedules ARE the approval.
  //
  // 2026-06-09 fix: under Slice 8.7B v2 the global `createIntent` already
  // auto-materializes L0-tier observations under balanced/free trust mode
  // (calls materializeIntent → createObservationFromIntent internally).
  // The previous code then ALSO called createObservationFromIntent
  // explicitly, producing a duplicate observation every fire.
  //
  // Now we let createIntent do its thing, then:
  //   - if it auto-executed (mode=balanced/free + L0): use its resulted_in
  //   - if it didn't (mode=cautious): manually approve + materialise once
  // Either way, ONE observation per fire.
  const payload: ObservationPayload = {
    title: finding.title,
    body: finding.body,
  };
  const intent = await createIntent({
    kind: "observation",
    payload,
    proposed_by: "duffy-scheduler",
    rationale: `Auto-fired by schedule "${s.name}" (${s.action_kind})`,
    evidence: [],
    importance: finding.importance,
  });

  if (intent.status === "approved" && intent.resulted_in) {
    // Auto-execute path already materialised. Done.
    return intent.resulted_in;
  }

  // Manual path — trust mode = cautious, so createIntent left it pending.
  // Schedules ARE the user's prior approval, so we force-approve here.
  await decideIntent(intent.id, "approved");
  const obs = await createObservationFromIntent({
    intent_id: intent.id,
    title: payload.title,
    body: payload.body,
    evidence: [],
    source_agent_id: "duffy-scheduler",
    reason: intent.rationale,
    importance: finding.importance,
  });
  return obs.id;
}
