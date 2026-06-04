/**
 * POST   /api/vault/todos/priority  → promote file into `05 - Queue/首要待辦/`
 * DELETE /api/vault/todos/priority  → demote file back to `05 - Queue/`
 *
 * Body: { file: string }   // vault-relative path
 *
 * 2026-06-04 rewrite: priority is now folder membership, not an overlay
 * store + `#首要` tag. Clicking an item in the UI moves its file in/out
 * of `首要待辦/` and that move is the only source of truth. The next
 * `scanTodos` call reads the new location and sets `isPriority`
 * accordingly — no separate JSON to keep in sync, no Markdown writes.
 */

import { promises as fs } from "node:fs";
import { join, basename, relative } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { vaultPath, bustCache } from "@/lib/vault/reader";
import { PRIORITY_SUBFOLDER } from "@/lib/vault/todos";

export const dynamic = "force-dynamic";

const QUEUE_DIR = "05 - Queue";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

type Body = { file?: unknown };

function parseBody(b: Body): { file: string } | null {
  if (typeof b?.file !== "string" || !b.file) return null;
  return { file: b.file };
}

/** Resolve a vault-relative path to absolute, refusing anything that
 *  escapes the vault root or leaves `05 - Queue/`. Guards against
 *  path-traversal in the request body. */
function resolveQueueFile(rel: string): string | null {
  const root = vaultPath();
  const abs = join(root, rel);
  const back = relative(root, abs);
  if (back.startsWith("..") || !back.startsWith(QUEUE_DIR + "/")) return null;
  return abs;
}

async function moveFile(rel: string, intoPriority: boolean): Promise<{
  ok: boolean;
  newPath?: string;
  error?: string;
}> {
  const src = resolveQueueFile(rel);
  if (!src) return { ok: false, error: "path outside queue" };
  const root = vaultPath();
  const fileName = basename(src);
  const destDir = intoPriority
    ? join(root, QUEUE_DIR, PRIORITY_SUBFOLDER)
    : join(root, QUEUE_DIR);
  const dest = join(destDir, fileName);
  if (src === dest) {
    // Already in the right place — nothing to do.
    return { ok: true, newPath: relative(root, dest) };
  }
  try {
    await fs.mkdir(destDir, { recursive: true });
    await fs.rename(src, dest);
    // Bust the scanTodos cache so the next /api/vault/todos call sees
    // the new layout. Without this the UI refetch returns the cached
    // pre-move list and the item appears not to have moved — that's
    // the bug Yen reported on 2026-06-04.
    bustCache("todos:");
    return { ok: true, newPath: relative(root, dest) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = parseBody(await req.json().catch(() => ({})));
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const result = await moveFile(body.file, true);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, newPath: result.newPath });
}

export async function DELETE(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = parseBody(await req.json().catch(() => ({})));
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const result = await moveFile(body.file, false);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, newPath: result.newPath });
}
