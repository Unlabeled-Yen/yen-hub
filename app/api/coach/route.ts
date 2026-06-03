/**
 * GET /api/coach
 *
 * Returns the cached coach card ("今天 Duffy 想跟你說"). Pass `?refresh=1`
 * to force regeneration. Cache TTL = 1 hour; auto-busts when an observation
 * / silhouette / summary lands (callers must invoke `bustCoachCache()`).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  bustCoachCache,
  generateCoachCard,
} from "@/lib/agent/duffy/coach";

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
  if (url.searchParams.get("refresh") === "1") {
    bustCoachCache();
  }
  try {
    const card = await generateCoachCard();
    return NextResponse.json({ card });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
