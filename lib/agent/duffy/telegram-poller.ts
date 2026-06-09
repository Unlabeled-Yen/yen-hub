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

  const history = await readTelegramHistory(m.chat_id);
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
    token: cfg.telegram_bot_token,
    chat_id: m.chat_id,
    text: reply,
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
