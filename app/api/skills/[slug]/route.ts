/**
 * GET /api/skills/[slug] — raw SKILL.md content (for editing).
 * PUT /api/skills/[slug] — overwrite SKILL.md with body.content.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { readSkill, writeSkill } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { slug } = await ctx.params;
  try {
    const content = await readSkill(slug);
    if (content === null) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ slug, content });
  } catch {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { slug } = await ctx.params;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const content = (body as { content?: unknown }).content;
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    await writeSkill(slug, content);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }
}
