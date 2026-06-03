/**
 * GET /api/summaries/current
 *
 * Returns the current ISO-week summary if one has been approved this week,
 * else null. Page B's summary-view consumes this.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getCurrentWeekSummary } from "@/lib/agent/storage/summaries";
import { isoWeek } from "@/lib/agent/storage/types";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET() {
  const auth = await ensureAuth();
  if (auth) return auth;
  const summary = await getCurrentWeekSummary();
  return NextResponse.json({ summary, week: isoWeek() });
}
