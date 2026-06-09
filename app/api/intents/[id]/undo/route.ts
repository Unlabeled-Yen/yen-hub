/**
 * POST /api/intents/[id]/undo
 *
 * Slice 8.7B v2 — undo an L0 auto-executed intent within a 24h window.
 *
 * Only intents with `decided_by === "auto"` are eligible. The reverse-
 * action set is intentionally narrow:
 *   - observation: delete from observations.json. The vault Markdown
 *                  mirror is NOT deleted (Yen's vault is sacred — the
 *                  hint endpoint surfaces this caveat so the UI can
 *                  show "我從清單拿掉了；vault 裡那條沒動").
 *
 * Other kinds default to L1 so they never auto-execute — they don't need
 * undo. If we expand L0 later (e.g. todo_plan), this endpoint grows.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getIntent, markUndone } from "@/lib/agent/storage/intents";
import { deleteObservation } from "@/lib/agent/storage/observations";

export const dynamic = "force-dynamic";

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { id } = await ctx.params;

  const intent = await getIntent(id);
  if (!intent) {
    return NextResponse.json({ error: "intent not found" }, { status: 404 });
  }
  if (intent.decided_by !== "auto") {
    return NextResponse.json(
      { error: "only auto-executed intents can be undone" },
      { status: 409 },
    );
  }
  if (intent.undone_at) {
    return NextResponse.json(
      { error: "already undone", undone_at: intent.undone_at },
      { status: 409 },
    );
  }
  if (
    !intent.decided_at ||
    Date.now() - intent.decided_at > UNDO_WINDOW_MS
  ) {
    return NextResponse.json(
      { error: "undo window (24h) elapsed" },
      { status: 410 },
    );
  }

  // Kind-dispatched reverse action.
  let reversed: unknown = null;
  let caveat: string | null = null;

  if (intent.kind === "observation" && intent.resulted_in) {
    const obs = await deleteObservation(intent.resulted_in);
    reversed = { kind: "observation", deleted_id: obs?.id ?? null };
    caveat =
      "我從清單拿掉了；vault 裡 06 - AI Data/Observations/ 那條 .md 沒動。要刪自己刪。";
  } else {
    return NextResponse.json(
      {
        error: `undo not implemented for kind: ${intent.kind}`,
      },
      { status: 501 },
    );
  }

  const updated = await markUndone(id);
  return NextResponse.json({
    intent: updated,
    reversed,
    caveat,
  });
}
