/**
 * GET  /api/conversations         — list (newest first)
 * POST /api/conversations         — upsert one
 *   body: { id, title, messages, createdAt, updatedAt }
 *
 * Slice 8.7 — server-side conversation persistence (replaces client localStorage).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  listConversations,
  saveConversation,
  type Conversation,
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

export async function GET() {
  const auth = await ensureAuth();
  if (auth) return auth;
  const conversations = await listConversations();
  return NextResponse.json({ conversations });
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const c = body as Partial<Conversation>;
  if (!c.id || !Array.isArray(c.messages)) {
    return NextResponse.json(
      { error: "id and messages[] required" },
      { status: 400 },
    );
  }
  const normalised: Conversation = {
    id: c.id,
    title: c.title ?? null,
    messages: c.messages,
    createdAt: c.createdAt ?? Date.now(),
    updatedAt: c.updatedAt ?? Date.now(),
    pinned: c.pinned ?? false,
    group: c.group ?? null,
  };
  await saveConversation(normalised);
  return NextResponse.json({ ok: true, conversation: normalised });
}
