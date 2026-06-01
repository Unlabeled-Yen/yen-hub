"use client";

/**
 * Shared fetch for /api/vault/attention. Both AttentionGrid and
 * ReadingProgress need the same payload — before this hook they each
 * fired their own request on mount, hitting the vault filesystem twice
 * in parallel and worsening the first-paint stutter.
 *
 * Module-level cache + inflight dedup means the first caller fetches,
 * the second caller hops onto the same promise and reuses the result.
 *
 * Stale-while-revalidate is intentionally omitted — vault data doesn't
 * change during a session unless the user manually triggers a sync.
 * If we add a refetch trigger later it can extend this hook.
 */

import { useEffect, useState } from "react";

// Untyped here on purpose — each call site casts to its own
// AttentionResponse shape so we don't have to keep two duplicate
// type definitions in sync from this layer.
let cached: unknown = null;
let inflight: Promise<unknown> | null = null;

async function fetchAttention(): Promise<unknown> {
  const r = await fetch("/api/vault/attention?days=7", {
    credentials: "same-origin",
  });
  if (!r.ok) throw new Error(`attention HTTP ${r.status}`);
  return r.json();
}

export function useAttention<T>(): T | null {
  const [data, setData] = useState<T | null>(cached as T | null);

  useEffect(() => {
    if (cached) {
      setData(cached as T);
      return;
    }
    let cancelled = false;
    if (!inflight) {
      inflight = fetchAttention().then((json) => {
        cached = json;
        return json;
      });
    }
    inflight
      .then((json) => {
        if (!cancelled) setData(json as T);
      })
      .catch(() => {
        /* swallow — caller renders nothing on null */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return data;
}
