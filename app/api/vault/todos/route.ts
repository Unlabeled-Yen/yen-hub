/**
 * GET /api/vault/todos
 *
 * Scan vault markdown for unfinished TODOs, filter out items hidden by the
 * local done-store overlay, return up to 50 visible items (mtime desc).
 * Also returns the current done count so the UI can show a sync badge.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { cached } from "@/lib/vault/reader";
import { scanTodos } from "@/lib/vault/todos";
import { loadDoneMap, todoKey } from "@/lib/vault/done-store";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    // Scan a generous window so post-filter still has 50 visible items
    // even when many recent commitments are already marked done.
    const items = await cached("todos:all", () => scanTodos(200));
    const done = await loadDoneMap();
    const filtered = items
      .filter((t) => !done[todoKey(t.file, t.text)])
      .slice(0, 50);
    const doneCount = Object.keys(done).length;
    return NextResponse.json({ items: filtered, doneCount });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
