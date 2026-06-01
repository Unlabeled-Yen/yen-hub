/**
 * GET /api/vault/attention?days=7
 *
 * Thin wrapper over `lib/vault/attention-data.ts#buildAttention`. The actual
 * data-building logic was extracted in Slice 6 so Duffy's
 * `read_attention_state` tool can share the same cached builder without a
 * loopback HTTP round-trip.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { buildAttention } from "@/lib/vault/attention-data";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const url = new URL(req.url);
  const days = Math.max(
    1,
    Math.min(90, Number(url.searchParams.get("days") ?? "7")),
  );
  try {
    const data = await buildAttention(days);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
