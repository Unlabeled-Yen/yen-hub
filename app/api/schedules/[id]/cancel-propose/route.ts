/**
 * POST /api/schedules/[id]/cancel-propose
 *
 * User-driven cancel: creates a schedule_cancel intent that lands in
 * the 02 待辦 deck. After approval the schedule is disabled. Mirrors
 * Duffy's `cancel_schedule` tool for the UI side.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createIntent } from "@/lib/agent/storage/intents";
import { getSchedule } from "@/lib/agent/storage/schedules";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as { rationale?: unknown };
  const rationale =
    typeof body.rationale === "string" && body.rationale.trim().length >= 5
      ? body.rationale.trim()
      : "使用者要求取消";

  const target = await getSchedule(id);
  if (!target) {
    return NextResponse.json({ error: "schedule not found" }, { status: 404 });
  }
  if (!target.enabled) {
    return NextResponse.json(
      { error: "schedule already disabled" },
      { status: 409 },
    );
  }

  const intent = await createIntent({
    kind: "schedule_cancel",
    payload: { schedule_id: id, rationale },
    proposed_by: "yen",
    rationale,
    evidence: [],
    importance: "medium",
  });

  return NextResponse.json({
    intent_id: intent.id,
    target_name: target.name,
  });
}
