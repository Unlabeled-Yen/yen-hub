/**
 * /api/trust-config
 *
 * GET  — current mode + 7-day approve/reject stats.
 * POST — set mode (`{ mode: "cautious" | "balanced" | "free" }`).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  getTrustConfig,
  setTrustMode,
  type TrustMode,
} from "@/lib/agent/storage/trust-config";
import { listIntents } from "@/lib/agent/storage/intents";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function statsLast7d(): Promise<{ approved: number; rejected: number }> {
  const cutoff = Date.now() - WINDOW_MS;
  const approved = (await listIntents({ status: "approved" })).filter(
    (i) => i.decided_at && i.decided_at > cutoff,
  ).length;
  const rejected = (await listIntents({ status: "rejected" })).filter(
    (i) => i.decided_at && i.decided_at > cutoff,
  ).length;
  return { approved, rejected };
}

export async function GET() {
  const auth = await ensureAuth();
  if (auth) return auth;
  const cfg = await getTrustConfig();
  const stats = await statsLast7d();
  return NextResponse.json({
    mode: cfg.mode,
    updated_at: cfg.updated_at,
    stats,
    kind_overrides: cfg.kind_overrides ?? {},
    auto_pilot: cfg.auto_pilot ?? false,
    auto_pilot_last_run: cfg.auto_pilot_last_run ?? null,
    notifications_enabled: cfg.notifications_enabled ?? false,
  });
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
  const mode = body.mode as TrustMode;
  if (mode !== "cautious" && mode !== "balanced" && mode !== "free") {
    return NextResponse.json(
      { error: "mode must be cautious | balanced | free" },
      { status: 400 },
    );
  }
  const updated = await setTrustMode(mode);
  return NextResponse.json({ mode: updated.mode, updated_at: updated.updated_at });
}
