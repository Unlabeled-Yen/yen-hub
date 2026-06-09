/**
 * POST /api/auto-pilot/toggle
 *
 * Slice 12 Phase 4 — enable / disable auto-pilot trust.
 * Body: { enabled: boolean }
 *
 * When flipped ON, runs one evaluation pass immediately so the user sees
 * first-pass actions without waiting up to 24h.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { setAutoPilot } from "@/lib/agent/storage/trust-config";
import { evaluateAndApply } from "@/lib/agent/duffy/auto-pilot";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;

  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
  const enabled = body.enabled === true;
  const cfg = await setAutoPilot(enabled);

  let firstPass = null;
  if (enabled) {
    firstPass = await evaluateAndApply(true);
  }

  return NextResponse.json({
    auto_pilot: cfg.auto_pilot ?? false,
    first_pass: firstPass,
  });
}
