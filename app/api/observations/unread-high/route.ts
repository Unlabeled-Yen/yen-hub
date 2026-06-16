/**
 * GET /api/observations/unread-high
 *
 * Returns the count + list of HIGH-importance observations the user hasn't
 * marked as read. Page A's DuffyBadge polls this.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  countUnreadHighImportance,
  isFreshUnreadHigh,
  listObservations,
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

export async function GET() {
  const auth = await ensureAuth();
  if (auth) return auth;
  const count = await countUnreadHighImportance();
  // Surface a few headlines too for the badge tooltip / hover.
  // Patch D (2026-06-14) — top list 跟 count 共用同一個 freshness 視窗 (24h)，
  // 避免「count = 6 但點開只看到今天 1 條」這種不一致。
  const all = await listObservations({ agent: "duffy" });
  const now = Date.now();
  const top = all
    .filter((o) => isFreshUnreadHigh(o, now))
    .slice(0, 5)
    .map((o) => ({ id: o.id, title: o.title, created_at: o.created_at }));
  return NextResponse.json({ count, top });
}
