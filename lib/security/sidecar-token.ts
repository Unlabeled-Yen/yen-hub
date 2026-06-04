/**
 * Client-side helper — read the per-startup sidecar token that Rust passes
 * via the initial navigation URL, cache it, and stamp it onto outgoing
 * /api fetches as `X-Yen-Token`.
 *
 * Why URL transport (and not Tauri `invoke`)
 * ------------------------------------------
 * Tauri 2's ACL blocks invoke calls to custom commands on webviews
 * navigated to a non-frontendDist origin (which is our case — Rust
 * navigates the webview from the splash to http://127.0.0.1:<ephemeral>
 * once the Node sidecar is ready). Adding the right capability/permission
 * would work but every future `tauri::command` would have to remember to
 * register its own permission entry. The URL path side-steps Tauri ACL
 * entirely.
 *
 * Transport details (matches the comment in src-tauri/src/sidecar.rs)
 *   - Rust navigates to `http://127.0.0.1:<port>/?_yt=<token>` after the
 *     sidecar binds.
 *   - This module reads `?_yt=` at first import, stashes the token in
 *     module-level cache + sessionStorage, then `history.replaceState`s
 *     the query away so the token never appears in subsequent client
 *     navigations, the URL bar, or screenshots.
 *   - sessionStorage is what survives Cmd+R reload: the reload re-fetches
 *     `/` from the sidecar (no `_yt` on the URL anymore), but the same
 *     WKWebView session keeps sessionStorage.
 *   - Same-origin /api fetches inside the webview pick the token up via
 *     `tokenFetch` / `sidecarHeaders` / `withSidecarToken`.
 *
 * Dev mode (browser at localhost:3000): no `_yt` query, no sessionStorage
 * entry, getSidecarToken returns "". Middleware also bypasses the token
 * check when its env var is unset, so dev still works end-to-end.
 */

const TOKEN_HEADER = "X-Yen-Token";
const STORAGE_KEY = "yen-hub:sidecar-token";
const URL_PARAM = "_yt";

let cached: string | null = null;

function readFromUrlAndStash(): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get(URL_PARAM);
    if (fromQuery) {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, fromQuery);
      } catch {
        /* sessionStorage can throw in private windows / disabled storage */
      }
      url.searchParams.delete(URL_PARAM);
      // Strip the query so the token doesn't survive in the URL bar or
      // get carried into subsequent navigations.
      window.history.replaceState(null, "", url.toString());
      return fromQuery;
    }
    try {
      return window.sessionStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  } catch {
    return "";
  }
}

/** Returns the cached token or "" if none is available. */
export function getSidecarToken(): string {
  if (cached !== null) return cached;
  cached = readFromUrlAndStash();
  return cached;
}

/** Returns headers including X-Yen-Token if available. */
export function sidecarHeaders(): Record<string, string> {
  const t = getSidecarToken();
  return t ? { [TOKEN_HEADER]: t } : {};
}

/** Wrap RequestInit with the sidecar token header. Safe to call always —
 *  no-op when no token is available. */
export function withSidecarToken(init?: RequestInit): RequestInit {
  const extra = sidecarHeaders();
  if (Object.keys(extra).length === 0) return init ?? {};
  return {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      ...extra,
    },
  };
}

/** Convenience — fetch with sidecar token auto-injected. */
export function tokenFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, withSidecarToken(init));
}
