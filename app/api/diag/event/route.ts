/**
 * POST /api/diag/event — client → server diagnostic relay.
 *
 * WKWebView's console.error doesn't propagate to the Tauri stderr stream,
 * so client-side logs invisible. This endpoint lets the client POST a
 * JSON payload that the server then writes to stderr — visible in
 * /tmp/yen-app.log when the binary is launched via tee.
 *
 * Auth-exempt (in middleware EXEMPT_PREFIXES via /api/diag/).
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch {
    payload = "(no json)";
  }
  console.error("[diag-event]", JSON.stringify(payload));
  return NextResponse.json({ ok: true });
}
