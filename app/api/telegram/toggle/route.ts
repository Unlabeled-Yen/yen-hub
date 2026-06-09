/**
 * POST /api/telegram/toggle
 *
 * Body:
 *   { token, chat_id, enabled, test? }
 *
 * - token / chat_id may be omitted to keep previous values
 * - enabled=true requires both token AND chat_id present
 * - test=true sends one verification message (only if enabled lands true)
 *
 * GET /api/telegram/toggle — returns current state (without leaking token).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  getTrustConfig,
  setTelegramConfig,
} from "@/lib/agent/storage/trust-config";
import { sendTelegram } from "@/lib/agent/telegram";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function tokenPreview(token?: string): string | null {
  if (!token) return null;
  if (token.length < 8) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export async function GET() {
  const auth = await ensureAuth();
  if (auth) return auth;
  const cfg = await getTrustConfig();
  return NextResponse.json({
    enabled: cfg.telegram_enabled ?? false,
    has_token: !!cfg.telegram_bot_token,
    token_preview: tokenPreview(cfg.telegram_bot_token),
    chat_id: cfg.telegram_chat_id ?? null,
  });
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = (await req.json().catch(() => ({}))) as {
    token?: unknown;
    chat_id?: unknown;
    enabled?: unknown;
    test?: unknown;
  };
  const token =
    typeof body.token === "string"
      ? body.token
      : body.token === null
        ? null
        : undefined;
  const chat_id =
    typeof body.chat_id === "number"
      ? body.chat_id
      : body.chat_id === null
        ? null
        : undefined;
  const enabled = body.enabled === true;
  const test = body.test === true;

  const cfg = await setTelegramConfig({ token, chat_id, enabled });

  let test_result: { ok: boolean; error?: string } | null = null;
  if (test && cfg.telegram_enabled && cfg.telegram_bot_token && cfg.telegram_chat_id) {
    const r = await sendTelegram({
      token: cfg.telegram_bot_token,
      chat_id: cfg.telegram_chat_id,
      text: "✅ Duffy ↔ Telegram 連線成功\n從現在起、reminder + 醒提會推到這、你也可以直接跟 Duffy 對話",
    });
    test_result = r.ok
      ? { ok: true }
      : { ok: false, error: r.error };
  }

  return NextResponse.json({
    enabled: cfg.telegram_enabled ?? false,
    has_token: !!cfg.telegram_bot_token,
    chat_id: cfg.telegram_chat_id ?? null,
    test_result,
  });
}
