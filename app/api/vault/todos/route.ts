/**
 * GET /api/vault/todos
 *
 * Scan vault markdown for unfinished TODOs (top 200 by mtime). Items are
 * NOT filtered server-side — the client handles three views:
 *   - 首要代辦 (priority) — items whose file lives in `05 - Queue/首要待辦/`
 *     (set on each item via `isPriority`; no overlay store)
 *   - 總覽代辦 (category) — all active (≤ 7 day-old) items grouped
 *   - 審查 (review)       — items older than 7 days
 *
 * `doneKeys`     → which items are currently struck-through (Priority only,
 *                  user-curated overlay in app data)
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
    // Bumped from 50 → 200 so the Review (≥ 7d) pool isn't empty.
    const items = await cached("todos:all", () => scanTodos(200));
    const done = await loadDoneMap();
    return NextResponse.json({
      items,
      doneKeys: Object.keys(done),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
