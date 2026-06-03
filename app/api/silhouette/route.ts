/**
 * GET /api/silhouette
 *
 * Returns the current silhouette (highest-version), or { silhouette: null }
 * if Duffy hasn't been bootstrapped yet. Page B's silhouette-view consumes
 * this.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getCurrentSilhouette } from "@/lib/agent/storage/silhouettes";

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
  const silhouette = await getCurrentSilhouette();
  return NextResponse.json({ silhouette });
}
