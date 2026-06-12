/**
 * Client-side event bus for intent state changes.
 *
 * Why: panels like SilhouetteView, SummaryView, etc. show data that's derived
 * from intents. When an intent is decided/materialised, those panels were
 * silently stale until the next remount or page reload — because each panel
 * only fetched on mount and had no way to know "something I care about just
 * happened".
 *
 * This module is a tiny pub/sub layer on the `window`. Producers (decide flow,
 * bootstrap, telegram inbound, etc.) dispatch; consumers (panels) subscribe
 * with a kind-filter and refetch.
 *
 * In-tab only (no SSE / WebSocket). The fanout is `window.dispatchEvent`, so
 * cross-tab UI invalidation needs a server-pushed channel — that's a separate
 * slice. For now: the realistic case (user clicks approve and looks at the
 * panel) is the same tab, so this is enough.
 */

export type IntentEventDetail = {
  /** The intent kind, used by subscribers to filter. */
  kind: string;
  /** What happened. `decided` = user pressed approve/reject; `materialised`
   *  = side-effect (file write, silhouette update) completed; `auto_executed`
   *  = L0 path skipped queue and ran immediately. */
  event: "decided" | "materialised" | "auto_executed";
  /** The intent id, for logging / debugging. */
  intentId: string;
  /** Decision outcome (only meaningful for `decided`). */
  decision?: "approved" | "rejected";
};

const EVENT_NAME = "yenhub:intent-event";

/** Dispatch from any client code path that affects intent state. Safe to call
 *  from server-rendered code paths too — guards on `typeof window`. */
export function emitIntentEvent(detail: IntentEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
}

/** Subscribe to all intent events. Returns an unsubscribe function. Pass a
 *  filter for kinds you care about; without a filter you get everything. */
export function onIntentEvent(
  handler: (detail: IntentEventDetail) => void,
  filterKinds?: string[],
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<IntentEventDetail>).detail;
    if (!detail) return;
    if (filterKinds && !filterKinds.includes(detail.kind)) return;
    handler(detail);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
