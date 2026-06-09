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
import type {
  Intent,
  IntentStatus,
  ObservationPayload,
} from "@/lib/agent/storage/types";

/** Minimal title extractor — only observations auto-execute under v1, so
 *  this is intentionally narrow. Expand if more L0 kinds land. */
function autoTitle(i: Intent): string {
  if (i.kind === "observation") {
    return (i.payload as ObservationPayload).title;
  }
  return `${i.kind}`;
}

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

  // Slice 8.7B v2 — recent auto-executed (within 24h, not undone).
  const recentAuto = byStatus.approved.filter(
    (i) => i.decided_by === "auto" && !i.undone_at,
  );
  const [undoBusy, setUndoBusy] = useState<string | null>(null);

  const onUndo = async (id: string) => {
    if (undoBusy === id) return;
    setUndoBusy(id);
    try {
      await tokenFetch(`/api/intents/${id}/undo`, { method: "POST" });
      await load();
    } finally {
      setUndoBusy(null);
    }
  };

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

      {/* ── Recent auto-executed (Slice 8.7B v2) — only when ≥1 ───────── */}
      {recentAuto.length > 0 && (
        <div
          className="mt-3 rounded-lg border px-3 py-2.5"
          style={{
            background: "rgba(0, 229, 180, 0.025)",
            borderColor: "rgba(0, 229, 180, 0.15)",
          }}
        >
          <div className="text-[9px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)] mb-2">
            近 24h 自動執行 · {recentAuto.length}
          </div>
          <ul className="flex flex-col gap-1">
            {recentAuto.slice(0, 5).map((i) => (
              <li
                key={i.id}
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="text-[var(--fg-1)] truncate flex-1" title={autoTitle(i)}>
                  · {autoTitle(i)}
                </span>
                <button
                  type="button"
                  disabled={undoBusy === i.id}
                  onClick={() => onUndo(i.id)}
                  className="shrink-0 px-1.5 py-0.5 text-[9px] font-mono tracking-[0.18em] uppercase rounded border text-[var(--fg-3)] hover:text-[var(--warn)] hover:border-[var(--warn)] transition-colors disabled:opacity-40"
                  style={{ borderColor: "rgba(255,255,255,0.10)" }}
                  title="從 observations.json 移除（vault Markdown 鏡像不動）"
                >
                  {undoBusy === i.id ? "..." : "撤銷"}
                </button>
              </li>
            ))}
          </ul>
          {recentAuto.length > 5 && (
            <div className="mt-1 text-[9px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
              還有 {recentAuto.length - 5} 筆未顯示
            </div>
          )}
        </div>
      )}

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
