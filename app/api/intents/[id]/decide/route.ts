/**
 * POST /api/intents/[id]/decide
 *
 * Body: { decision: "approve" | "reject" }
 *
 * Slice 8.7B v2 refactor: the per-kind side effects were extracted into
 * `lib/agent/intent-materialize.ts` so the same logic runs for HTTP
 * approve AND for createIntent auto-execute under L0 trust.
 *
 * Idempotent: deciding an already-decided intent returns the existing record
 * without re-running side effects.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { decideIntent, getIntent } from "@/lib/agent/storage/intents";
import { materializeIntent } from "@/lib/agent/intent-materialize";
import { bustCoachCache } from "@/lib/agent/duffy/coach";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

type Body = { decision?: unknown };

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as Body;
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: "decision must be 'approve' or 'reject'" },
      { status: 400 },
    );
  }

  const existing = await getIntent(id);
  if (!existing) {
    return NextResponse.json({ error: "intent not found" }, { status: 404 });
  }

  // Already decided — return current state, don't double-write.
  if (existing.status !== "pending") {
    return NextResponse.json({ intent: existing, materialised: null });
  }

  // Reject path — just flip the status, no side effects.
  if (decision === "reject") {
    const updated = await decideIntent(id, "rejected");
    return NextResponse.json({ intent: updated, materialised: null });
  }

  // Approve path — delegate side effects to the shared materializer.
  const r = await materializeIntent(existing);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error.message, ...(r.error.extra ?? {}) },
      { status: r.error.code },
    );
  }
  const updated = await decideIntent(id, "approved", r.resulted_in, "user");
  bustCoachCache();
  return NextResponse.json({ intent: updated, materialised: r.materialised });
}
