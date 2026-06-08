/**
 * GET /api/schedules
 *
 * List schedules with computed next_fire / cron description / single-event
 * flags. Read-only — schedule creation is Duffy-only (propose_schedule tool).
 *
 * Slice 11.1 — the manual POST handler was removed; all schedule creation
 * now flows through "tell Duffy in natural language". Same for cancel
 * (use the row's cancel button, which calls /api/schedules/[id]/cancel-propose).
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listSchedules } from "@/lib/agent/storage/schedules";
import {
  parseCron,
  nextFire,
  describeCron,
} from "@/lib/agent/duffy/cron-utils";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
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

  const xs = await listSchedules();
  const now = new Date();
  const data = xs.map((s) => {
    let next: string | null = null;
    let description = s.cron_expr;
    try {
      const parsed = parseCron(s.cron_expr);
      next = nextFire(parsed, now).toISOString();
      description = describeCron(s.cron_expr);
    } catch {
      /* leave defaults */
    }
    return {
      id: s.id,
      name: s.name,
      cron_expr: s.cron_expr,
      cron_description: description,
      action_kind: s.action_kind,
      action_payload: s.action_payload,
      enabled: s.enabled,
      fire_count: s.fire_count,
      last_fired_at: s.last_fired_at ?? null,
      next_fire: next,
      one_shot: s.one_shot ?? false,
      not_before: s.not_before ?? null,
      created_by: s.created_by,
      created_at: s.created_at,
      rationale: s.rationale,
    };
  });

  return NextResponse.json({ schedules: data });
}
