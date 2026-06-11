/**
 * DELETE /api/schedules/[id]
 *
 * Manual hard-delete of a schedule. Unlike cancel-propose (which routes a
 * schedule_cancel intent through 02 待辦 and merely disables the row), this
 * removes the row from the store outright. It exists so spent one-shots and
 * already-disabled schedules don't pile up in the panel forever.
 *
 * This is a direct destructive action — it deliberately bypasses the
 * propose-approve gate, because the user is doing housekeeping on their own
 * schedules. The panel guards it with a two-step click confirm.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { deleteSchedule } from "@/lib/agent/storage/schedules";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { id } = await ctx.params;

  const removed = await deleteSchedule(id);
  if (!removed) {
    return NextResponse.json({ error: "schedule not found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: id });
}
