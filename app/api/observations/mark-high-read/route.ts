/**
 * POST /api/observations/mark-high-read
 *
 * Marks ALL unread HIGH-importance observations as read. Called when Yen
 * enters Page B (one-shot dismissal — simpler than per-observation marking
 * for v1).
 *
 * Returns the new unread count (should be 0).
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  countUnreadHighImportance,
  listObservations,
  markObservationRead,
} from "@/lib/agent/storage/observations";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST() {
  const auth = await ensureAuth();
  if (auth) return auth;
  const all = await listObservations({ agent: "duffy" });
  const unreadHigh = all.filter((o) => o.importance === "high" && !o.read_at);
  for (const o of unreadHigh) {
    await markObservationRead(o.id);
  }
  const count = await countUnreadHighImportance();
  return NextResponse.json({ marked: unreadHigh.length, remaining: count });
}
