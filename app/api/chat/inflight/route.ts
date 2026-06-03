/**
 * GET    /api/chat/inflight?conversation=<id>
 * DELETE /api/chat/inflight?conversation=<id>
 *
 * Slice 7.7: when Yen reopens the chat palette, the client polls this
 * endpoint to see if Duffy was mid-thought when the palette closed. If yes,
 * the client merges the cached text back into the conversation.
 *
 * GET returns the inflight entry (or null) without mutating; the client
 * decides when to acknowledge.
 *
 * DELETE removes the entry — call this once you've successfully merged a
 * 'done' or 'error' response into the conversation, so future GETs don't
 * re-surface it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  clearInflight,
  getInflight,
} from "@/lib/agent/duffy/inflight-store";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

function extractConvoId(req: NextRequest): string | null {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("conversation");
  const fromHeader = req.headers.get("x-conversation-id");
  return fromQuery || fromHeader || null;
}

export async function GET(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const convoId = extractConvoId(req);
  if (!convoId) {
    return NextResponse.json(
      { error: "missing ?conversation=<id>" },
      { status: 400 },
    );
  }
  const entry = await getInflight(convoId);
  return NextResponse.json({ inflight: entry });
}

export async function DELETE(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const convoId = extractConvoId(req);
  if (!convoId) {
    return NextResponse.json(
      { error: "missing ?conversation=<id>" },
      { status: 400 },
    );
  }
  await clearInflight(convoId);
  return NextResponse.json({ ok: true });
}
