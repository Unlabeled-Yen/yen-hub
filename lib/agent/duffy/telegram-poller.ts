/**
 * Telegram long-poll runner.
 *
 * Sits in instrumentation.ts as a background loop. Every cycle:
 *   1. Reads trust-config → if telegram disabled, sleep + retry.
 *   2. Long-poll getUpdates with cursor.
 *   3. For each message: drop if not from the configured chat_id (anti-
 *      hijack), else feed Duffy headless + reply.
 *   4. Persist cursor so we don't re-process on restart.
 *
 * Disable via `TELEGRAM_POLLER_DISABLED=1`.
 */

import {
  downloadTelegramFile,
  getTelegramUpdates,
  sendTelegram,
  type TgMessage,
} from "@/lib/agent/telegram";
import { transcribeAudio } from "@/lib/agent/voice/transcribe";
import {
  getTrustConfig,
  setTelegramLastUpdateId,
} from "@/lib/agent/storage/trust-config";
import {
  appendTelegramMessage,
  readTelegramHistory,
} from "@/lib/agent/storage/telegram-chats";
import { runDuffyHeadless } from "@/lib/agent/duffy/headless";
import { withTelegramTurn } from "@/lib/agent/duffy/telegram-mutex";
import { getIntent, decideIntent } from "@/lib/agent/storage/intents";
import { materializeIntent } from "@/lib/agent/intent-materialize";
import {
  getPendingSkillSession,
  clearPendingSkillSession,
} from "@/lib/agent/duffy/pending-skill-session";
import type { UIMessage } from "ai";

type State = { started: boolean; loopActive: boolean };
const state: State = { started: false, loopActive: false };

const IDLE_DELAY_MS = 30_000; // when disabled, recheck config every 30s
const ERROR_BACKOFF_MS = 10_000;

/** Strip the mandatory `[mode]` tag from Duffy's first line before sending
 *  to Telegram. The tag is useful in the .app chat surface (will be styled
 *  as a colored badge eventually) but reads as plain-text noise on a phone.
 *  Duffy still infers the mode internally — we just hide the marker. */
function stripModeTag(text: string): string {
  // Matches: "[coach]" / "[do (locked)]" / etc, optionally followed by newlines.
  return text.replace(
    /^\s*\[(coach|do|watch|pair)(\s*\(locked\))?\]\s*\n+/i,
    "",
  );
}

/** Affirmative tokens that, in the narrow context of a freshly-proposed
 *  journal-interview file_create intent, mean "approve and persist".
 *  Kept tight on purpose — see §3.5 design rationale. */
const APPROVE_TOKENS = new Set([
  "存",
  "存檔",
  "好",
  "ok",
  "OK",
  "Ok",
  "yes",
  "Yes",
  "YES",
  "是",
  "同意",
]);

const SENTINEL_RE = /<<INTENT:(int_[a-z0-9-]+)>>/i;
const JOURNAL_PATH_RE = /^07 - 個人日記\/\d{4}-\d{2}-\d{2}\.md$/;

/** Affirmative replies to a pending-skill prompt — "yes, start now". */
const SKILL_START_TOKENS = new Set([
  "好",
  "好啊",
  "好的",
  "開始",
  "ok",
  "OK",
  "Ok",
  "yes",
  "Yes",
  "YES",
  "嗯",
  "可以",
  "來",
]);

/** Defer tokens — "not now, ask later". */
const SKILL_DEFER_TOKENS = new Set([
  "等等",
  "等一下",
  "晚點",
  "之後",
  "稍後",
  "no",
  "No",
  "NO",
  "不要",
  "先不",
  "現在不行",
]);

/** §3.6 pre-Duffy intercept — skill-anchored reminders (2026-06-13).
 *  When a scheduler fired with ask_first semantics, a marker sits in the
 *  pending-skill store. Yen's first reply to the prompt either starts the
 *  skill flow or defers it — Duffy never sees this message. */
async function tryStartPendingSkill(
  chatId: number,
  userText: string,
): Promise<string | null> {
  const session = await getPendingSkillSession(chatId);
  if (!session) return null;

  const trimmed = userText.trim();

  if (SKILL_START_TOKENS.has(trimmed)) {
    await clearPendingSkillSession(chatId);
    if (session.skill === "journal_interview") {
      // Re-import to avoid circular deps.
      const { runJournalInterviewNow } = await import(
        "@/lib/agent/duffy/schedule-actions"
      );
      const today =
        (session.context?.today as string | undefined) ??
        new Date().toISOString().slice(0, 10);
      await runJournalInterviewNow(today);
      // Q1 was sent by runJournalInterviewNow — no extra reply needed.
      // Return empty string to indicate "intercept handled it silently".
      return "";
    }
    return null;
  }

  if (SKILL_DEFER_TOKENS.has(trimmed)) {
    await clearPendingSkillSession(chatId);
    return `好，先放著。需要時跟我說「開始日記訪談」、或告訴我延幾分鐘我重排（例：「30 分鐘後」）。`;
  }

  // Neither yes nor no — leave the marker, fall through to Duffy. Duffy can
  // still respond freely; if Yen later says "好" the marker is still live.
  return null;
}

/** Inspect the most-recent assistant turn in this chat. If it carries an
 *  <<INTENT:xxx>> sentinel AND the intent is a journal-day file_create
 *  AND it's still pending AND `userText` is an approve token → approve it
 *  in-process and return a confirmation message. Otherwise return null,
 *  meaning "no interception, fall through to Duffy". */
async function tryApproveJournalIntent(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  userText: string,
): Promise<string | null> {
  const trimmed = userText.trim();
  if (!APPROVE_TOKENS.has(trimmed)) return null;

  // Walk backward to find the latest assistant message (skip recent user
  // turns just in case the history has been re-ordered).
  let lastAssistant: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      lastAssistant = history[i].text;
      break;
    }
  }
  if (!lastAssistant) return null;

  const match = lastAssistant.match(SENTINEL_RE);
  if (!match) return null;
  const intentId = match[1];

  const intent = await getIntent(intentId);
  if (!intent) return null;
  if (intent.status !== "pending") return null;
  if (intent.kind !== "file_create") return null;

  const path = (intent.payload as { path?: unknown }).path;
  if (typeof path !== "string" || !JOURNAL_PATH_RE.test(path)) return null;

  // Window confirmed — approve in-process, mirroring app/api/intents/[id]/decide.
  const r = await materializeIntent(intent);
  if (!r.ok) {
    return `⚠️ 存檔失敗：${r.error.message}（請開 Yen.app 手動處理）`;
  }
  await decideIntent(intent.id, "approved", r.resulted_in, "user");
  return `✅ 已存到 ${path}`;
}

function tgHistoryToUiMessages(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  latestUser: string,
): UIMessage[] {
  const msgs: UIMessage[] = history.map((m, i) => ({
    id: `tg-hist-${i}`,
    role: m.role,
    parts: [{ type: "text", text: m.text }],
  }));
  msgs.push({
    id: `tg-now`,
    role: "user",
    parts: [{ type: "text", text: latestUser }],
  });
  return msgs;
}

async function processMessage(m: TgMessage): Promise<void> {
  const cfg = await getTrustConfig();
  if (!cfg.telegram_enabled || !cfg.telegram_bot_token) return;
  // Anti-hijack: only respond to the configured chat_id.
  if (cfg.telegram_chat_id !== m.chat_id) {
    console.warn(
      `[telegram-poller] drop message from chat_id=${m.chat_id} (not configured)`,
    );
    return;
  }

  // Slash-command short-circuit
  if (m.text.startsWith("/start")) {
    await sendTelegram({
      token: cfg.telegram_bot_token,
      chat_id: m.chat_id,
      text: "👋 Duffy 在線。直接打字、或按住麥克風錄語音都可以。",
    });
    return;
  }

  // Slice 元能力 #3 — voice / audio handling.
  // If the message is audio, download → Whisper → use transcription as
  // the user's text. Echo the transcription back so user can verify.
  let userText = m.text;
  if (m.audio) {
    const dl = await downloadTelegramFile({
      token: cfg.telegram_bot_token,
      file_id: m.audio.file_id,
    });
    if (!dl.ok) {
      await sendTelegram({
        token: cfg.telegram_bot_token,
        chat_id: m.chat_id,
        text: `⚠️ 抓不到語音檔：${dl.error}`,
      });
      return;
    }
    const tx = await transcribeAudio({
      buffer: dl.buffer,
      mimeType: m.audio.mime_type,
      filename: m.audio.filename,
    });
    if (!tx.ok) {
      await sendTelegram({
        token: cfg.telegram_bot_token,
        chat_id: m.chat_id,
        text: `⚠️ 轉錄失敗：${tx.error}`,
      });
      return;
    }
    userText = tx.text;
    // Echo what we heard so user can correct it. Tiny duration label too.
    const durLabel = tx.duration_seconds
      ? ` · ${Math.round(tx.duration_seconds)}秒`
      : "";
    await sendTelegram({
      token: cfg.telegram_bot_token,
      chat_id: m.chat_id,
      text: `🎙 ${userText}${durLabel}`,
    });
  }

  if (!userText || !userText.trim()) {
    // Nothing usable to send to Duffy (empty text, empty transcription).
    return;
  }

  await withTelegramTurn(m.chat_id, async () => {
    const history = await readTelegramHistory(m.chat_id);

    // §3.6 pre-Duffy intercept — skill-anchored reminder. Check FIRST so
    // it wins over §3.5 intent-approve (a pending skill session is more
    // load-bearing than a save-confirmation).
    //
    // IMPORTANT: append the user's "好" to history BEFORE invoking the
    // skill flow. Otherwise the skill flow's runDuffyHeadless reads a
    // pre-confirmation history and ends up with storage out of sync
    // with the Telegram timeline (Q1 lands before "好" in storage).
    {
      const session = await getPendingSkillSession(m.chat_id);
      if (session) {
        await appendTelegramMessage(m.chat_id, {
          role: "user",
          text: userText,
          ts: Date.now(),
        });
        const skillIntercept = await tryStartPendingSkill(m.chat_id, userText);
        if (skillIntercept !== null) {
          // Empty string = handled silently (Q1 already sent by skill flow).
          if (skillIntercept.length > 0) {
            await appendTelegramMessage(m.chat_id, {
              role: "assistant",
              text: skillIntercept,
              ts: Date.now(),
            });
            await sendTelegram({
              token: cfg.telegram_bot_token!,
              chat_id: m.chat_id,
              text: skillIntercept,
            });
          }
          return;
        }
        // No-match path (neither yes nor defer): we already appended the
        // user message above, so skip the lower append and fall through.
        const uiMessages = tgHistoryToUiMessages(
          await readTelegramHistory(m.chat_id),
          "",
        );
        const result = await runDuffyHeadless({
          messages: uiMessages,
          surface: "telegram",
        });
        let reply: string;
        if (result.ok) {
          await appendTelegramMessage(m.chat_id, {
            role: "assistant",
            text: result.text,
            ts: Date.now(),
          });
          reply = stripModeTag(result.text);
        } else {
          reply = `⚠️ Duffy 跑出問題：${result.error}`;
        }
        await sendTelegram({
          token: cfg.telegram_bot_token!,
          chat_id: m.chat_id,
          text: reply,
        });
        return;
      }
    }

    // §3.5 pre-Duffy intercept — narrow window: pending journal file_create
    // intent + affirmative token → approve in-process, skip Duffy.
    const intercept = await tryApproveJournalIntent(history, userText);
    if (intercept !== null) {
      await appendTelegramMessage(m.chat_id, {
        role: "user",
        text: userText,
        ts: Date.now(),
      });
      await appendTelegramMessage(m.chat_id, {
        role: "assistant",
        text: intercept,
        ts: Date.now(),
      });
      await sendTelegram({
        token: cfg.telegram_bot_token!,
        chat_id: m.chat_id,
        text: intercept,
      });
      return;
    }

    await appendTelegramMessage(m.chat_id, {
      role: "user",
      text: userText,
      ts: Date.now(),
    });

    const uiMessages = tgHistoryToUiMessages(history, userText);
    const result = await runDuffyHeadless({
      messages: uiMessages,
      surface: "telegram",
    });

    let reply: string;
    if (result.ok) {
      // Keep the full text (with mode tag) in history so context continuity
      // is preserved — Duffy may notice his own past stance.
      await appendTelegramMessage(m.chat_id, {
        role: "assistant",
        text: result.text,
        ts: Date.now(),
      });
      // Strip the [mode] tag only for the user-facing send.
      reply = stripModeTag(result.text);
    } else {
      reply = `⚠️ Duffy 卡住了：${result.error}`;
    }

    await sendTelegram({
      token: cfg.telegram_bot_token!,
      chat_id: m.chat_id,
      text: reply,
    });
  });
}

async function loop(): Promise<void> {
  if (state.loopActive) return;
  state.loopActive = true;
  let iterCount = 0;
  while (state.started) {
    iterCount++;
    try {
      const cfg = await getTrustConfig();
      if (!cfg.telegram_enabled || !cfg.telegram_bot_token) {
        if (iterCount % 10 === 1) {
          console.log("[telegram-poller] idle (not configured)");
        }
        await new Promise((r) => setTimeout(r, IDLE_DELAY_MS));
        continue;
      }
      const offset = cfg.telegram_last_update_id
        ? cfg.telegram_last_update_id + 1
        : undefined;
      console.log(`[telegram-poller] iter=${iterCount} fetch offset=${offset ?? "(none)"}`);
      const updates = await getTelegramUpdates({
        token: cfg.telegram_bot_token,
        offset,
      });
      if (updates.length === 0) {
        console.log(`[telegram-poller] iter=${iterCount} empty (long-poll timeout)`);
        continue;
      }
      console.log(`[telegram-poller] got ${updates.length} update(s)`);

      // Process in order; track highest update_id.
      let maxId = offset ? offset - 1 : 0;
      for (const u of updates) {
        if (u.update_id > maxId) maxId = u.update_id;
        console.log(
          `[telegram-poller] processing update_id=${u.update_id} text="${u.text.slice(0, 40)}"`,
        );
        try {
          await processMessage(u);
          console.log(`[telegram-poller] done update_id=${u.update_id}`);
        } catch (e) {
          console.warn(
            `[telegram-poller] processMessage ${u.update_id} failed:`,
            e,
          );
        }
      }
      await setTelegramLastUpdateId(maxId);
    } catch (e) {
      console.warn("[telegram-poller] loop error:", e);
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
  state.loopActive = false;
}

export function startTelegramPoller(): void {
  if (state.started) return;
  if (process.env.TELEGRAM_POLLER_DISABLED === "1") {
    console.log("[telegram-poller] disabled via TELEGRAM_POLLER_DISABLED=1");
    return;
  }
  state.started = true;
  void loop().catch((e) => console.error("[telegram-poller] crashed:", e));
  console.log("[telegram-poller] started");
}

export function stopTelegramPoller(): void {
  state.started = false;
}
