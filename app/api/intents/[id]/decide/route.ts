/**
 * POST /api/intents/[id]/decide
 *
 * Body: { decision: "approve" | "reject" }
 *
 * On approve for an `observation` intent: creates an Observation in
 * observations.json and backlinks it to the intent via `resulted_in`.
 *
 * Idempotent: deciding an already-decided intent returns the existing record
 * without re-running side effects.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { decideIntent, getIntent } from "@/lib/agent/storage/intents";
import { createObservationFromIntent } from "@/lib/agent/storage/observations";

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
    return NextResponse.json({ intent: existing, observation: null });
  }

  // Approve path — for `observation` kind, materialise an Observation.
  let observation = null;
  if (decision === "approve" && existing.kind === "observation") {
    observation = await createObservationFromIntent({
      intent_id: existing.id,
      title: existing.payload.title,
      body: existing.payload.body,
      zone: existing.payload.zone,
      window: existing.payload.window,
      evidence: existing.evidence,
      source_agent_id: existing.proposed_by,
      reason: existing.rationale,
    });
  }

  const updated = await decideIntent(
    id,
    decision === "approve" ? "approved" : "rejected",
    observation?.id,
  );

  return NextResponse.json({ intent: updated, observation });
}
