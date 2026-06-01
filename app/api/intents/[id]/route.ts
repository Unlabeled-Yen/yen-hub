/**
 * GET /api/intents/[id]
 *
 * Fetch a single intent by id. Used by `<IntentCard>` to hydrate its rendering
 * from a sentinel `<<INTENT:int_xxx>>` parsed out of a chat message. Returns
 * 404 if the id doesn't exist (which can happen if Yen wiped intents.json).
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getIntent } from "@/lib/agent/storage/intents";

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
  const intent = await getIntent(id);
  if (!intent) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ intent });
}
