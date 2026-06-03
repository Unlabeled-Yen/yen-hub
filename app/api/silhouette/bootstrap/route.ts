/**
 * POST /api/silhouette/bootstrap
 *
 * Triggers Duffy to draft v1 of Yen's silhouette from existing signals.
 * Creates a `silhouette_update` intent with field="full"; Yen approves via
 * the chat palette in the normal flow.
 *
 * Idempotent: if a silhouette already exists, returns ok=true + a note.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { bootstrapSilhouette } from "@/lib/agent/duffy/bootstrap";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  try {
    const intent = await bootstrapSilhouette();
    if (!intent) {
      return NextResponse.json({
        ok: true,
        already_bootstrapped: true,
      });
    }
    return NextResponse.json({
      ok: true,
      intent_id: intent.id,
      already_bootstrapped: false,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
