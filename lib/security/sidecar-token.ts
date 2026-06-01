/**
 * Client-side helper — fetch the per-startup sidecar token from the Rust
 * side once, memoise, and stamp it onto outgoing /api fetches.
 *
 * The token is generated fresh on every Yen.app launch (see
 * `src-tauri/src/sidecar.rs`). Without it, `middleware.ts` rejects /api
 * requests with 403 in production. In dev (browser at localhost:3000 or
 * Tauri dev without a token), `invoke()` is unavailable / returns "", so
 * we silently skip the header — middleware also bypasses when its env var
 * is unset, so dev still works.
 */

const TOKEN_HEADER = "X-Yen-Token";

let cached: string | null = null;
let inflight: Promise<string> | null = null;

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function fetchToken(): Promise<string> {
  if (!hasTauriRuntime()) return "";
  let invoke: (cmd: string) => Promise<unknown>;
  try {
    ({ invoke } = await import("@tauri-apps/api/core"));
  } catch {
    return "";
  }
  // Rust may still be spawning the sidecar — `get_sidecar_token` returns ""
  // until launch completes. Poll briefly.
  for (let i = 0; i < 30; i++) {
    try {
      const t = (await invoke("get_sidecar_token")) as string;
      if (t) return t;
    } catch {
      return "";
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return "";
}

/** Returns the cached token or "" if none is available. Caches forever
 *  within a page session — token is stable across the app's lifetime. */
export async function getSidecarToken(): Promise<string> {
  if (cached !== null) return cached;
  if (!inflight) inflight = fetchToken();
  cached = await inflight;
  return cached;
}

/** Returns headers including X-Yen-Token if available. */
export async function sidecarHeaders(): Promise<Record<string, string>> {
  const t = await getSidecarToken();
  return t ? { [TOKEN_HEADER]: t } : {};
}

/** Wrap RequestInit with the sidecar token header. Safe to call always —
 *  no-op when no token is available. */
export async function withSidecarToken(init?: RequestInit): Promise<RequestInit> {
  const extra = await sidecarHeaders();
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
export async function tokenFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, await withSidecarToken(init));
}
