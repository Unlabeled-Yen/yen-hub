"use client";

/**
 * IntentQueue — Slice 8.7 Phase A.3 (lapel pattern).
 *
 * The sidebar surface ("lapel") is intentionally quiet — it shows ONLY
 * the count of pending intents plus a button to enter full-screen review
 * (the "deck"). Approved/rejected history surfaces as a muted footer line.
 *
 * Why lapel + deck: the inline-list pattern (each card vertical) breaks
 * the side-by-side layout with CoachCard whenever there are 2+ intents.
 * Lapel keeps the sidebar at a fixed compact height regardless of count,
 * and the deck turns review into a focal, ceremonial moment.
 */

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import { IntentDeck } from "@/components/page-b/intent-deck";
import type { Intent, IntentStatus } from "@/lib/agent/storage/types";

const POLL_MS = 30_000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function IntentQueue() {
  const [byStatus, setByStatus] = useState<Record<IntentStatus, Intent[]>>({
    pending: [],
    approved: [],
    rejected: [],
  });
  const [loaded, setLoaded] = useState(false);
  const [deckOpen, setDeckOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a, r] = await Promise.all([
        tokenFetch("/api/intents?status=pending"),
        tokenFetch("/api/intents?status=approved"),
        tokenFetch("/api/intents?status=rejected"),
      ]);
      const pj = p.ok ? ((await p.json()) as { intents: Intent[] }) : null;
      const aj = a.ok ? ((await a.json()) as { intents: Intent[] }) : null;
      const rj = r.ok ? ((await r.json()) as { intents: Intent[] }) : null;

      const cutoff = Date.now() - RECENT_WINDOW_MS;
      const recent = (xs: Intent[]) =>
        xs.filter((i) => (i.decided_at ? i.decided_at > cutoff : true));

      setByStatus({
        pending: pj?.intents ?? [],
        approved: recent(aj?.intents ?? []),
        rejected: recent(rj?.intents ?? []),
      });
      setLoaded(true);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const pendingCount = byStatus.pending.length;
  const approvedCount = byStatus.approved.length;
  const rejectedCount = byStatus.rejected.length;
  const hasPending = pendingCount > 0;

  return (
    <>
      <div
        className="rounded-xl border flex flex-col items-center justify-center text-center p-6 min-h-[260px] transition-colors"
        style={{
          background: hasPending
            ? "rgba(255, 181, 71, 0.04)"
            : "rgba(255,255,255,0.02)",
          borderColor: hasPending
            ? "rgba(255, 181, 71, 0.35)"
            : "var(--border-subtle)",
        }}
      >
        {!loaded ? (
          <div className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-3)]">
            loading…
          </div>
        ) : hasPending ? (
          <>
            {/* Lapel — the big number, like a pinned brooch */}
            <div className="mb-1 flex items-baseline gap-2">
              <span
                className="text-[64px] leading-none tabular-nums"
                style={{
                  color: "var(--warn)",
                  fontFamily: "var(--font-display)",
                }}
              >
                {pendingCount}
              </span>
              <span
                className="text-[10px] font-mono tracking-[0.28em] uppercase"
                style={{ color: "var(--warn)" }}
              >
                ⚐
              </span>
            </div>
            <div className="mb-5 text-[10px] font-mono tracking-[0.28em] uppercase text-[var(--fg-2)]">
              張卡待你審視
            </div>
            <button
              type="button"
              onClick={() => setDeckOpen(true)}
              className="px-4 py-2 text-[10px] font-mono tracking-[0.28em] uppercase rounded transition-opacity hover:opacity-80"
              style={{
                background: "rgba(255, 181, 71, 0.10)",
                border: "1px solid var(--warn)",
                color: "var(--warn)",
              }}
            >
              展開審視
            </button>
          </>
        ) : (
          <>
            {/* Empty state — quiet, no pulsing */}
            <div
              className="text-[40px] leading-none mb-3 opacity-40"
              style={{ color: "var(--accent)" }}
            >
              ✓
            </div>
            <div className="text-[11px] text-[var(--fg-2)] mb-1">
              沒有待批准的卡
            </div>
            <div className="text-[9px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
              Duffy 正在觀察
            </div>
          </>
        )}

        {/* Footer — muted 24h history (always shown when loaded) */}
        {loaded && (approvedCount > 0 || rejectedCount > 0) && (
          <div className="mt-6 pt-4 border-t border-[var(--border-subtle)] w-full text-[9px] font-mono tracking-[0.22em] uppercase text-[var(--fg-3)]">
            近 24h · 通過 {approvedCount} / 拒絕 {rejectedCount}
          </div>
        )}
      </div>

      {/* ── Deck modal (rendered via AnimatePresence for smooth exit) ── */}
      <AnimatePresence>
        {deckOpen && (
          <IntentDeck
            intents={byStatus.pending}
            onClose={() => setDeckOpen(false)}
            onDecided={() => void load()}
          />
        )}
      </AnimatePresence>
    </>
  );
}
