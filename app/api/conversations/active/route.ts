/**
 * GET /api/conversations/active        — { active_id }
 * PUT /api/conversations/active        — body: { id: string | null }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getActiveId, setActiveId } from "@/lib/agent/storage/conversations";

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
  const active_id = await getActiveId();
  return NextResponse.json({ active_id });
}

export async function PUT(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { id } = (body ?? {}) as { id?: string | null };
  await setActiveId(id ?? null);
  return NextResponse.json({ ok: true, active_id: id ?? null });
}
