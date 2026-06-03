/**
 * Edge middleware — sidecar token gate for /api/*.
 *
 * Threat: Yen Hub's Node sidecar binds to 127.0.0.1:<ephemeral>. By default
 * any other local process on the Mac can hit it and read/write Yen's state.
 * This middleware demands the request carry `X-Yen-Token` matching the
 * per-startup token Rust generates and passes to Node via env. The webview
 * gets that token via the `?_yt=` query on the initial navigation; see
 * `lib/security/sidecar-token.ts` for the client side.
 *
 * Origin defence: even when the token check is bypassed in dev, we still
 * reject /api requests whose `Origin` looks like a real foreign website.
 */

import { NextRequest, NextResponse } from "next/server";

const TOKEN_HEADER = "x-yen-token";

/** Routes that must not require the sidecar token (auth bootstrap). */
const EXEMPT_PREFIXES = [
  "/api/auth/", // WebAuthn + native-confirm bootstrap
  "/api/diag/", // Diagnostic relay for client-side debug telemetry
];

function isExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

function isForeignOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return false;
    if (u.protocol === "tauri:" || u.protocol === "tauri-localhost:")
      return false;
    return true;
  } catch {
    return true;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (isExempt(pathname)) return NextResponse.next();

  const origin = req.headers.get("origin");
  const presented = req.headers.get(TOKEN_HEADER);
  const expected = process.env.YEN_HUB_TOKEN;

  if (isForeignOrigin(origin)) {
    return NextResponse.json(
      { error: "cross-origin api access denied" },
      { status: 403 },
    );
  }

  // No expected token = dev mode (sidecar not minting one); pass through.
  if (!expected) return NextResponse.next();

  if (presented !== expected) {
    return NextResponse.json(
      { error: "sidecar token missing or invalid" },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
