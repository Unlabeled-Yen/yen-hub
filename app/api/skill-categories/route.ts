/**
 * GET /api/skill-categories — { categories: { slug: category } }
 * PUT /api/skill-categories — body { slug, category }; category null clears.
 *
 * Separate top-level route (not under /api/skills/[slug]) to avoid the dynamic
 * segment collision. App-managed; does not touch the SKILL.md files.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { readCategories, setCategory } from "@/lib/skills/categories";

export const dynamic = "force-dynamic";

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
  const categories = await readCategories();
  return NextResponse.json({ categories });
}

export async function PUT(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { slug, category } = body as {
    slug?: unknown;
    category?: unknown;
  };
  if (typeof slug !== "string" || !/^[A-Za-z0-9._-]+$/.test(slug)) {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 });
  }
  if (category !== null && typeof category !== "string") {
    return NextResponse.json({ error: "invalid category" }, { status: 400 });
  }
  await setCategory(slug, category as string | null);
  return NextResponse.json({ ok: true });
}
