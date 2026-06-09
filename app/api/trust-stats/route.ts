/**
 * GET /api/trust-stats?days=30
 *
 * Slice 12 Phase 2 — exposes the grouped trust signal counts that Phase 3's
 * Suggest-tier banner will read. Pure read; no behavior side effects.
 *
 * Query:
 *   days — window in days (default 30, max 180).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { statsByKindAndProposer } from "@/lib/agent/storage/trust-signals";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;

  const url = new URL(req.url);
  const days = Math.max(
    1,
    Math.min(180, Number(url.searchParams.get("days") ?? "30")),
  );
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const stats = await statsByKindAndProposer({ since });

  return NextResponse.json({ window_days: days, groups: stats });
}
