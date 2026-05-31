/**
 * GET /api/vault/todos
 *
 * Scan vault markdown for unfinished TODOs (top 50 by mtime). Items that
 * have been struck through locally (via /complete) stay in the response —
 * the strike is a UI-only mark. `doneKeys` lets the UI restore which ones
 * are currently struck.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { cached } from "@/lib/vault/reader";
import { scanTodos } from "@/lib/vault/todos";
import { loadDoneMap } from "@/lib/vault/done-store";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const items = await cached("todos:all", () => scanTodos(50));
    const done = await loadDoneMap();
    const doneKeys = Object.keys(done);
    return NextResponse.json({ items, doneKeys });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
