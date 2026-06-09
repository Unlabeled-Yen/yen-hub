/**
 * GET /api/token-usage?days=1
 *
 * Slice 元能力 #1 — exposes today's (or window'd) LLM token rollup +
 * the current budget. UI uses this to render the usage bar.
 *
 * POST /api/token-usage/budget
 *
 * Body: { budget: number | null } — set / clear the daily budget.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  rollupForDate,
  rollupWindow,
} from "@/lib/agent/storage/token-usage";
import {
  getTrustConfig,
  setDailyTokenBudget,
} from "@/lib/agent/storage/trust-config";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;

  const url = new URL(req.url);
  const days = Math.max(
    0,
    Math.min(30, Number(url.searchParams.get("days") ?? "0")),
  );

  const today = await rollupForDate();
  const window = days > 0 ? await rollupWindow(days) : null;
  const cfg = await getTrustConfig();
  const budget = cfg.daily_token_budget ?? null;

  return NextResponse.json({
    today,
    window,
    budget,
    budget_pct: budget && budget > 0 ? (today.total / budget) * 100 : null,
  });
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = (await req.json().catch(() => ({}))) as {
    budget?: unknown;
  };
  const b = body.budget;
  const budget =
    b === null
      ? null
      : typeof b === "number" && Number.isFinite(b) && b > 0
        ? Math.floor(b)
        : null;
  const cfg = await setDailyTokenBudget(budget);
  return NextResponse.json({
    budget: cfg.daily_token_budget ?? null,
  });
}
