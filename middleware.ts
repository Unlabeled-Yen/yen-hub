/**
 * Edge middleware — sidecar token gate for /api/*.
 *
 * Threat: Yen Hub's Node sidecar binds to 127.0.0.1:<ephemeral>. By default
 * any other local process on the Mac can hit it and read/write Yen's state.
 * This middleware demands the request carry `X-Yen-Token` matching the
 * per-startup token Rust generates and passes to Node via env. The webview
 * fetches that token via Tauri's `get_sidecar_token` command and includes
 * it on every /api request.
 *
 * Dev escape: when `YEN_HUB_TOKEN` is unset (i.e. `pnpm dev` or `pnpm
 * tauri:dev` without a token plumbing), enforcement is OFF. Production
 * sidecar (`pnpm tauri:build` then run `Yen.app`) always sets it.
 *
 * Origin defence: even when the token check is bypassed in dev, we still
 * reject /api requests whose `Origin` looks like a real foreign website.
 * A bare missing-Origin (same-origin fetch from the loaded page, server-
 * side curl, Postman) is allowed because there's no consistent way to
 * distinguish those without breaking the app's own fetches.
 *
 * The check is intentionally not on /api/auth/* — auth flows happen
 * before the webview has a token, and they have their own session model.
 */

import { NextRequest, NextResponse } from "next/server";

const TOKEN_HEADER = "x-yen-token";

/** Routes that must not require the sidecar token (auth bootstrap etc). */
const EXEMPT_PREFIXES = [
  "/api/auth/", // WebAuthn + native-confirm bootstrap
];

function isExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

/** A foreign-origin request is one whose Origin starts with http(s) and is
 *  NOT a localhost / 127.0.0.1 / tauri:// origin. We reject those outright
 *  regardless of token state. */
function isForeignOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return false;
    if (u.protocol === "tauri:" || u.protocol === "tauri-localhost:")
      return false;
    return true;
  } catch {
    // Malformed Origin → suspicious; treat as foreign.
    return true;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (isExempt(pathname)) return NextResponse.next();

  // Cross-origin block — defends even in dev where token check is off.
  const origin = req.headers.get("origin");
  if (isForeignOrigin(origin)) {
    return NextResponse.json(
      { error: "cross-origin api access denied" },
      { status: 403 },
    );
  }

  const expected = process.env.YEN_HUB_TOKEN;
  if (!expected) {
    // Dev / unbundled mode — Rust hasn't minted a token. Skip enforcement.
    return NextResponse.next();
  }

  const presented = req.headers.get(TOKEN_HEADER);
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
