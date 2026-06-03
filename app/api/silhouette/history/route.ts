/**
 * GET /api/silhouette/history
 *
 * Returns all silhouette versions newest first. Page B can show a version
 * picker / diff view later.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listSilhouetteHistory } from "@/lib/agent/storage/silhouettes";

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
  const silhouettes = await listSilhouetteHistory();
  return NextResponse.json({ silhouettes });
}
