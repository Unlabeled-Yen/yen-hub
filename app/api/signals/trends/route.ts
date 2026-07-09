/**
 * GET /api/signals/trends?window=14&recent=3&limit=8
 *
 * Returns the IBM Think topic trend report — which topics are appearing at
 * an unusual rate relative to their own 14-day baseline (Z-score). Powers
 * the "本週熱詞" strip above the signal cards.
 *
 * Reads the append-only history written by /api/signals/ibm. Cheap (pure
 * file read + arithmetic), so no caching layer — recomputed per request.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { computeTopicTrends } from "@/lib/agent/signals/trends";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const sp = req.nextUrl.searchParams;
  const windowDays = clamp(Number(sp.get("window")) || 14, 1, 90);
  const recentDays = clamp(Number(sp.get("recent")) || 3, 1, windowDays);
  const limit = clamp(Number(sp.get("limit")) || 8, 1, 30);

  try {
    const report = await computeTopicTrends(windowDays, recentDays, limit);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "trend analysis failed" },
      { status: 500 },
    );
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
