/**
 * GET /api/summaries?limit=20
 *
 * Returns summaries newest first. Page B can show "previous weeks" carousel.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listSummaries } from "@/lib/agent/storage/summaries";

export const dynamic = "force-dynamic";

async function ensureAuth() {
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
    Math.min(50, Number(url.searchParams.get("limit") ?? "20")),
  );
  const summaries = await listSummaries(limit);
  return NextResponse.json({ summaries });
}
