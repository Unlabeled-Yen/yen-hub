/**
 * GET /api/auto-pilot/actions?limit=10
 *
 * Slice 12 Phase 4 — read recent auto-pilot actions for the audit-log UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { readRecentActions } from "@/lib/agent/storage/auto-pilot-log";

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
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get("limit") ?? "10")),
  );
  const actions = await readRecentActions(limit);
  return NextResponse.json({ actions });
}
