/**
 * GET /api/vault/todos
 *
 * Scan all markdown files for unfinished checkbox + natural-language TODOs.
 * Returns up to 50, sorted by file mtime desc (recent commitments first).
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { cached } from "@/lib/vault/reader";
import { scanTodos } from "@/lib/vault/todos";

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
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
