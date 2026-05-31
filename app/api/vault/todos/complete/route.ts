/**
 * POST   /api/vault/todos/complete  → mark a TODO done (adds to overlay)
 * DELETE /api/vault/todos/complete  → undo (removes from overlay)
 *
 * Body: { file: string, lineNum: number, text: string }
 *
 * The overlay hides the item from `/api/vault/todos` but does NOT touch the
 * vault .md file. Use `/api/vault/todos/sync` to flush completions back.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { markDone, unmarkDone } from "@/lib/vault/done-store";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

type Body = { file?: unknown; lineNum?: unknown; text?: unknown };

function parseBody(b: Body): { file: string; lineNum: number; text: string } | null {
  if (
    typeof b?.file !== "string" ||
    typeof b?.text !== "string" ||
    typeof b?.lineNum !== "number"
  ) {
    return null;
  }
  return { file: b.file, lineNum: b.lineNum, text: b.text };
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = parseBody(await req.json().catch(() => ({})));
  if (!body) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  await markDone(body.file, body.lineNum, body.text);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = parseBody(await req.json().catch(() => ({})));
  if (!body) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  await unmarkDone(body.file, body.text);
  return NextResponse.json({ ok: true });
}
