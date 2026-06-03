/**
 * GET /api/intents?status=pending&agent=duffy&kind=observation
 *
 * List intents. All filters optional. Returns newest first.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listIntents } from "@/lib/agent/storage/intents";
import type { IntentKind, IntentStatus } from "@/lib/agent/storage/types";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

const STATUSES = ["pending", "approved", "rejected"] as const;
const KINDS: ReadonlyArray<IntentKind> = [
  "observation",
  "silhouette_update",
  "summary",
] as const;

function asStatus(v: string | null): IntentStatus | undefined {
  return STATUSES.includes(v as IntentStatus) ? (v as IntentStatus) : undefined;
}

function asKind(v: string | null): IntentKind | undefined {
  return KINDS.includes(v as IntentKind) ? (v as IntentKind) : undefined;
}

export async function GET(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const url = new URL(req.url);
  const status = asStatus(url.searchParams.get("status"));
  const kind = asKind(url.searchParams.get("kind"));
  const proposed_by = url.searchParams.get("agent") ?? undefined;
  const intents = await listIntents({ status, kind, proposed_by });
  return NextResponse.json({ intents });
}
