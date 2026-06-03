/**
 * GET    /api/conversations/[id]
 * DELETE /api/conversations/[id]
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  getConversation,
  deleteConversation,
} from "@/lib/agent/storage/conversations";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  const c = await getConversation(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ conversation: c });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { id } = await ctx.params;
  const ok = await deleteConversation(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
