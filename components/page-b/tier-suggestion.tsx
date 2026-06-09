"use client";

/**
 * TierSuggestion — Slice 12 Phase 3.
 *
 * Reads /api/trust-stats and /api/trust-config, picks the strongest
 * "you'd benefit from L0-ing this kind" candidate, and surfaces it as a
 * mint banner above the Trust Dial. Yen accepts (升級) or mutes for 7d
 * (先觀察).
 *
 * Surface rules (Slice 12 SPEC §3.3):
 *   - sample size N ≥ 5
 *   - approve rate ≥ 90%
 *   - not already overridden to L0
 *   - not muted within last 7 days (localStorage)
 *
 * Only the single strongest candidate is shown at a time — pick by
 * "approve rate × log(N)" to weight both confidence and evidence. If
 * none qualify, the component renders nothing (zero footprint).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type GroupStat = {
  key: string;
  kind: string;
  proposed_by: string;
  approved: number;
  rejected: number;
  auto_approved: number;
  auto_undone: number;
  total_decided: number;
  approve_rate: number;
};

type ConfigResp = {
  mode: "cautious" | "balanced" | "free";
  kind_overrides?: Record<string, "L0" | "L1" | "L2">;
};

const KIND_LABEL: Record<string, string> = {
  observation: "觀察",
  silhouette_update: "剪影更新",
  summary: "週摘要",
  file_create: "新檔建立",
  file_edit: "檔案編輯",
  todo_plan: "待辦規劃",
  schedule_create: "排程建立",
  schedule_cancel: "排程取消",
};

const MIN_N = 5;
const MIN_RATE = 0.9;
const MUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function muteKey(kind: string): string {
  return `yen-hub:tier-suggest-mute:${kind}`;
}

function isMuted(kind: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(muteKey(kind));
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    return Number.isFinite(ts) && Date.now() - ts < MUTE_WINDOW_MS;
  } catch {
    return false;
  }
}

function mute(kind: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(muteKey(kind), String(Date.now()));
  } catch {
    /* silent */
  }
}

type Candidate = {
  kind: string;
  total_approved: number;
  total_decided: number;
  approve_rate: number;
};

/** Aggregate group stats up to the kind level (we override by kind, not by
 *  proposer, so per-proposer detail is summed away). */
function pickCandidate(
  groups: GroupStat[],
  overrides: Record<string, string>,
  isMutedFn: (kind: string) => boolean,
): Candidate | null {
  const byKind = new Map<string, Candidate>();
  for (const g of groups) {
    let c = byKind.get(g.kind);
    if (!c) {
      c = {
        kind: g.kind,
        total_approved: 0,
        total_decided: 0,
        approve_rate: 0,
      };
      byKind.set(g.kind, c);
    }
    c.total_approved += g.approved + g.auto_approved;
    c.total_decided += g.total_decided;
  }
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  for (const c of byKind.values()) {
    if (c.total_decided < MIN_N) continue;
    c.approve_rate = c.total_approved / c.total_decided;
    if (c.approve_rate < MIN_RATE) continue;
    if (overrides[c.kind] === "L0") continue;
    if (isMutedFn(c.kind)) continue;
    // Score = rate × log(N) — heavier evidence wins over marginally higher rate.
    const score = c.approve_rate * Math.log(c.total_decided + 1);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export function TierSuggestion() {
  const [groups, setGroups] = useState<GroupStat[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, "L0" | "L1" | "L2">>({});
  const [busy, setBusy] = useState(false);
  // Re-eval whenever mute state changes (e.g. user clicked dismiss)
  const [refreshTick, setRefreshTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [statsRes, cfgRes] = await Promise.all([
        tokenFetch("/api/trust-stats?days=30"),
        tokenFetch("/api/trust-config"),
      ]);
      if (statsRes.ok) {
        const data = (await statsRes.json()) as { groups: GroupStat[] };
        setGroups(data.groups);
      }
      if (cfgRes.ok) {
        const data = (await cfgRes.json()) as ConfigResp;
        setOverrides(data.kind_overrides ?? {});
      }
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const candidate = useMemo(() => {
    if (!groups) return null;
    return pickCandidate(groups, overrides, isMuted);
    // refreshTick used to force recomputation after mute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, overrides, refreshTick]);

  if (!candidate) return null;

  const label = KIND_LABEL[candidate.kind] ?? candidate.kind;
  const pct = Math.round(candidate.approve_rate * 100);

  const onPromote = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await tokenFetch("/api/trust-config/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: candidate.kind, tier: "L0" }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onDismiss = () => {
    mute(candidate.kind);
    setRefreshTick((n) => n + 1);
  };

  return (
    <div
      className="mb-4 rounded-lg border px-4 py-3 flex items-center gap-3"
      style={{
        background: "rgba(0, 229, 180, 0.04)",
        borderColor: "rgba(0, 229, 180, 0.30)",
      }}
    >
      <span
        className="text-[14px] leading-none"
        style={{ color: "var(--accent)" }}
      >
        💡
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] leading-snug text-[var(--fg-0)]">
          過去 30 天「{label}」你通過 {candidate.total_approved} / {candidate.total_decided} 條（{pct}%）
        </div>
        <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)] mt-0.5">
          要不要把這類升為自動執行？
        </div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onPromote}
        className="shrink-0 px-3 py-1.5 text-[10px] font-mono tracking-[0.24em] uppercase rounded transition-opacity disabled:opacity-40"
        style={{
          background: "rgba(0, 229, 180, 0.10)",
          border: "1px solid var(--accent)",
          color: "var(--accent)",
        }}
      >
        {busy ? "..." : "升級"}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 px-3 py-1.5 text-[10px] font-mono tracking-[0.24em] uppercase rounded border text-[var(--fg-3)] hover:text-[var(--fg-1)] transition-colors"
        style={{ borderColor: "rgba(255,255,255,0.10)" }}
      >
        先觀察
      </button>
    </div>
  );
}
