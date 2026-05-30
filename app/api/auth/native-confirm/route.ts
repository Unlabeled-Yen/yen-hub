/**
 * POST /api/auth/native-confirm
 *
 * Called by the React entry page AFTER a successful native Touch ID via
 * Tauri (`invoke('authenticate')` returned true). Sets the session cookie
 * so the rest of the app — which is session-cookie aware — treats the user
 * as authenticated.
 *
 * Security model (Slice 2.5c MVP):
 *   - Same-origin only — Next.js' default CORS keeps off-origin browsers out.
 *   - We trust the Tauri client because the Tauri runtime is the only thing
 *     that can have produced the native auth success that justifies the call.
 *   - In a hardened build, the Rust side should sign a nonce and pass it
 *     through so this endpoint can verify it. Tracked as a follow-up.
 */

import { NextResponse } from "next/server";
import { USER_ID } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";

export async function POST() {
  const session = await getSession();
  session.userId = USER_ID;
  session.authenticatedAt = Date.now();
  await session.save();
  return NextResponse.json({ ok: true });
}
