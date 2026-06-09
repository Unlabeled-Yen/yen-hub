/**
 * Audio transcription — Slice 元能力 #3.
 *
 * Single transport: OpenAI Whisper API (or any OpenAI-compatible endpoint
 * like Moonshot, Groq, Together).
 *
 * Config priority:
 *   1. WHISPER_API_KEY        — explicit override
 *   2. OPENAI_API_KEY         — standard OpenAI
 *   3. (none)                 — return { ok: false, error: "no key" }
 *
 *   WHISPER_BASE_URL          — defaults to https://api.openai.com
 *   WHISPER_MODEL             — defaults to "whisper-1"
 *
 * Other providers we considered + skipped:
 *   - whisper.cpp local: ~150MB model, must bundle into sidecar → bloats .app
 *   - macOS Speech.framework: requires Swift bridge through Tauri Rust side,
 *     adds platform-specific code path. Free but heavier to integrate.
 *
 * If a user without an OpenAI key wants this feature, they can point
 * WHISPER_BASE_URL at any OpenAI-compatible STT endpoint (Groq's free
 * tier is generous + uses identical wire format).
 */

const DEFAULT_BASE = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";

export type TranscribeResult =
  | { ok: true; text: string; duration_seconds?: number }
  | { ok: false; error: string };

export async function transcribeAudio(args: {
  /** Raw audio bytes. */
  buffer: ArrayBufferLike;
  /** Mime type — e.g. "audio/ogg" for Telegram voice, "audio/m4a" for iOS memos. */
  mimeType: string;
  /** Original filename — Whisper uses extension as a hint. */
  filename: string;
  /** Optional language hint (ISO-639-1, e.g. "zh", "en"). Auto-detect if omitted. */
  language?: string;
}): Promise<TranscribeResult> {
  const apiKey =
    process.env.WHISPER_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      error:
        "no whisper api key — set WHISPER_API_KEY or OPENAI_API_KEY in ~/.config/yen-hub/env",
    };
  }

  const baseURL = (
    process.env.WHISPER_BASE_URL ?? DEFAULT_BASE
  ).replace(/\/+$/, "");
  const model = process.env.WHISPER_MODEL ?? DEFAULT_MODEL;

  const form = new FormData();
  form.append(
    "file",
    new Blob([args.buffer as ArrayBuffer], { type: args.mimeType }),
    args.filename,
  );
  form.append("model", model);
  if (args.language) form.append("language", args.language);
  // Verbose JSON gives us duration_seconds for usage tracking.
  form.append("response_format", "verbose_json");

  try {
    const res = await fetch(`${baseURL}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "(no body)");
      return {
        ok: false,
        error: `whisper HTTP ${res.status}: ${txt.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      text?: string;
      duration?: number;
    };
    if (typeof data.text !== "string" || !data.text.trim()) {
      return { ok: false, error: "empty transcription" };
    }
    return {
      ok: true,
      text: data.text.trim(),
      duration_seconds: data.duration,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
