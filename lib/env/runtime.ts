/**
 * Runtime detection helpers.
 *
 * Tauri 2 injects `__TAURI_INTERNALS__` (and historically `__TAURI__`) on
 * the global window. Browsers don't, so we use those as the discriminator.
 */

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__) || Boolean(w.__TAURI__);
}
