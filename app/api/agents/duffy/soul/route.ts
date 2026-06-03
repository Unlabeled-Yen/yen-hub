/**
 * GET /api/agents/duffy/soul
 *
 * Returns the raw markdown of Duffy's SOUL file
 * (`06 - AI Data/agents/duffy.md`) for Page B's SoulView to render.
 *
 * SOUL is edited by Yen directly in Obsidian; changes take effect on the
 * next Duffy chat turn automatically (no sync button needed — the loader
 * reads fresh each session).
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { vaultPath } from "@/lib/vault/reader";

export const dynamic = "force-dynamic";

const SOUL_REL = "06 - AI Data/agents/duffy.md";

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
  try {
    const root = vaultPath();
    const abs = join(root, SOUL_REL);
    const stat = await fs.stat(abs);
    const content = await fs.readFile(abs, "utf8");
    return NextResponse.json({
      ok: true,
      path: SOUL_REL,
      mtimeMs: stat.mtimeMs,
      content,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        hint: "expected at <vault>/06 - AI Data/agents/duffy.md",
      },
      { status: 404 },
    );
  }
}
