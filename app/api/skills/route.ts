/**
 * GET /api/skills — list skills in the vault's 06 - AI Data/skills/.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { readCategories } from "@/lib/skills/categories";
import { listSkills } from "@/lib/skills/store";

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
  const [skills, categories] = await Promise.all([
    listSkills(),
    readCategories(),
  ]);
  const merged = skills.map((s) => ({
    ...s,
    category: categories[s.slug] ?? null,
  }));
  return NextResponse.json({ skills: merged });
}
