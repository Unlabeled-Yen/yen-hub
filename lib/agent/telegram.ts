/**
 * Telegram bot transport — 方向 2 / Telegram 整合.
 *
 * Pure HTTP wrappers over the Telegram Bot API. No LLM, no Duffy — just
 * send/receive on a token. Higher layers (poller, reminder hook) compose
 * these.
 *
 * Telegram API docs: https://core.telegram.org/bots/api
 */

const API = "https://api.telegram.org";
const SEND_TIMEOUT_MS = 10_000;
const LONG_POLL_TIMEOUT_S = 25; // Telegram caps at 50; 25 keeps reactivity.

/** Telegram has a 4096-char limit per message. Longer text is chunked. */
const TG_MAX_TEXT = 4000;

type SendResult =
  | { ok: true; message_id: number }
  | { ok: false; error: string };

export async function sendTelegram(args: {
  token: string;
  chat_id: number;
  text: string;
}): Promise<SendResult> {
  if (!args.token || !args.chat_id) {
    return { ok: false, error: "missing token or chat_id" };
  }
  const chunks = chunkText(args.text);
  let lastId = -1;
  for (const chunk of chunks) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
      const res = await fetch(`${API}/bot${args.token}/sendMessage`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: args.chat_id,
          text: chunk,
          // Markdown lite — Telegram MarkdownV2 is strict, default to plain.
        }),
      });
      clearTimeout(t);
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as {
        ok: boolean;
        result?: { message_id: number };
        description?: string;
      };
      if (!data.ok) {
        return { ok: false, error: data.description ?? "unknown" };
      }
      lastId = data.result?.message_id ?? -1;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { ok: true, message_id: lastId };
}

function chunkText(text: string): string[] {
  if (text.length <= TG_MAX_TEXT) return [text];
  // Prefer line / paragraph splits to avoid hacking words.
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > TG_MAX_TEXT) {
      if (buf) out.push(buf);
      buf = line;
      // If a single line is still too long, hard-cut it.
      while (buf.length > TG_MAX_TEXT) {
        out.push(buf.slice(0, TG_MAX_TEXT));
        buf = buf.slice(TG_MAX_TEXT);
      }
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Long-poll receive                                                          */
/* -------------------------------------------------------------------------- */

export type TgMessage = {
  update_id: number;
  message_id: number;
  chat_id: number;
  from_user_id: number;
  from_username?: string;
  /** Text content. Empty string when the message is voice / audio / document. */
  text: string;
  date: number;
  /** Slice 元能力 #3 — present when message is voice / audio / m4a doc. */
  audio?: {
    file_id: string;
    mime_type: string;
    duration?: number;
    /** Original filename for documents; synthesised for voice/audio. */
    filename: string;
  };
};

export async function getTelegramUpdates(args: {
  token: string;
  offset?: number;
}): Promise<TgMessage[]> {
  const params = new URLSearchParams({
    timeout: String(LONG_POLL_TIMEOUT_S),
    ...(args.offset ? { offset: String(args.offset) } : {}),
  });
  const url = `${API}/bot${args.token}/getUpdates?${params.toString()}`;
  // 60s outer timeout (poll is up to 25 + headroom).
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (LONG_POLL_TIMEOUT_S + 10) * 1000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      ok: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          message_id: number;
          chat?: { id: number };
          from?: { id: number; username?: string };
          text?: string;
          date: number;
        };
      }>;
    };
    if (!data.ok || !Array.isArray(data.result)) return [];
    const out: TgMessage[] = [];
    for (const u of data.result) {
      const m = u.message as
        | {
            message_id: number;
            chat?: { id: number };
            from?: { id: number; username?: string };
            text?: string;
            date: number;
            voice?: { file_id: string; mime_type: string; duration?: number };
            audio?: {
              file_id: string;
              mime_type: string;
              duration?: number;
              file_name?: string;
            };
            document?: {
              file_id: string;
              mime_type?: string;
              file_name?: string;
            };
          }
        | undefined;
      if (!m || !m.chat?.id || !m.from?.id) continue;

      // Detect voice / audio / m4a-document. Telegram represents these
      // with different message keys depending on how the user sent them.
      let audio: TgMessage["audio"] | undefined;
      if (m.voice) {
        audio = {
          file_id: m.voice.file_id,
          mime_type: m.voice.mime_type,
          duration: m.voice.duration,
          filename: `voice-${u.update_id}.ogg`,
        };
      } else if (m.audio) {
        audio = {
          file_id: m.audio.file_id,
          mime_type: m.audio.mime_type,
          duration: m.audio.duration,
          filename:
            m.audio.file_name ?? `audio-${u.update_id}.${guessExt(m.audio.mime_type)}`,
        };
      } else if (
        m.document &&
        m.document.mime_type &&
        m.document.mime_type.startsWith("audio/")
      ) {
        audio = {
          file_id: m.document.file_id,
          mime_type: m.document.mime_type,
          filename: m.document.file_name ?? `audio-${u.update_id}.m4a`,
        };
      }

      // Need either text or audio to be useful.
      if (!audio && typeof m.text !== "string") continue;

      out.push({
        update_id: u.update_id,
        message_id: m.message_id,
        chat_id: m.chat.id,
        from_user_id: m.from.id,
        from_username: m.from.username,
        text: m.text ?? "",
        date: m.date,
        audio,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function guessExt(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "bin";
}

/* -------------------------------------------------------------------------- */
/*  File download — used by voice/audio handling                               */
/* -------------------------------------------------------------------------- */

export async function downloadTelegramFile(args: {
  token: string;
  file_id: string;
}): Promise<{ ok: true; buffer: ArrayBuffer } | { ok: false; error: string }> {
  try {
    // Step 1: get file_path
    const infoRes = await fetch(
      `${API}/bot${args.token}/getFile?file_id=${encodeURIComponent(args.file_id)}`,
    );
    if (!infoRes.ok) {
      return { ok: false, error: `getFile HTTP ${infoRes.status}` };
    }
    const info = (await infoRes.json()) as {
      ok: boolean;
      result?: { file_path?: string };
    };
    if (!info.ok || !info.result?.file_path) {
      return { ok: false, error: "no file_path in getFile response" };
    }

    // Step 2: download bytes
    const fileURL = `${API}/file/bot${args.token}/${info.result.file_path}`;
    const fileRes = await fetch(fileURL);
    if (!fileRes.ok) {
      return { ok: false, error: `download HTTP ${fileRes.status}` };
    }
    const buffer = await fileRes.arrayBuffer();
    return { ok: true, buffer };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
