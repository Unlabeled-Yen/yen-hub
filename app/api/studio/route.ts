/**
 * GET /api/studio — real cross-project work-state for the studio face.
 *
 * Deterministic (git + checkpoint memory), read live each call — cheap enough
 * (~5 projects × a few git calls) that a cache would only add staleness.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { readStudioState } from "@/lib/studio/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const projects = readStudioState();
    return NextResponse.json({ projects, generated_at: Date.now() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
