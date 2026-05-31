/**
 * WebAuthn config for Yen Hub.
 *
 * For localhost dev:
 *   - RP_ID must be "localhost" (no port)
 *   - ORIGIN must include port
 *
 * For production (later):
 *   - RP_ID = your real domain (e.g. "yen-hub.vercel.app")
 *   - ORIGIN = "https://yen-hub.vercel.app"
 */

const isProd = process.env.NODE_ENV === "production";

export const RP_NAME = "Yen Hub";
export const RP_ID = isProd
  ? process.env.RP_ID ?? "localhost"
  : "localhost";
export const ORIGIN = isProd
  ? process.env.ORIGIN ?? "http://localhost:3000"
  : "http://localhost:3000";

// Single-user hub — Yen is the only user.
export const USER_ID = "yen";
export const USER_NAME = "Yen";
export const USER_DISPLAY_NAME = "Yen";

// Session cookie config
export const SESSION_COOKIE = "yen-hub-session";
export const SESSION_PASSWORD =
  process.env.SESSION_PASSWORD ??
  // Dev fallback — replace via env in production. Must be ≥32 chars.
  "dev-only-fallback-session-key-please-change-me-32chars";

// Tauri sidecar serves over plain http://127.0.0.1:<port> — WKWebView drops
// Secure-flagged cookies on non-https origins, which silently breaks login.
// PWA-on-Vercel (future) opts back in by setting YEN_REQUIRE_SECURE=1.
const requireSecure = isProd && process.env.YEN_REQUIRE_SECURE === "1";

export const SESSION_OPTIONS = {
  password: SESSION_PASSWORD,
  cookieName: SESSION_COOKIE,
  cookieOptions: {
    secure: requireSecure,
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
};

export type SessionData = {
  userId?: string;
  authenticatedAt?: number;
};
