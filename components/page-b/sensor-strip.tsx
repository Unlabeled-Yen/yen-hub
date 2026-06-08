"use client";

/**
 * SensorStrip — Slice 8.7 Phase A.
 *
 * Sits at the top of Duffy's page (above 01 今日). Shows what Duffy is
 * currently "seeing" — a thin horizontal banner with three cells:
 *   1. AttentionGrid pulse — top 3 zones by activity, dot-coded
 *   2. Recent Observations — last 3 obs titles with importance dot
 *   3. Intent inbox count — pending intents waiting for approval
 *
 * Polls every 60s. Read-only — clicking a cell scrolls to the matching
 * section below (intents → 02 待辦, observations → 03 剪影).
 */

import { useCallback, useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import type { AttentionResponse, Zone } from "@/lib/vault/attention-types";

const POLL_MS = 60_000;

type ObsLite = { id: string; title: string; importance?: number };

type SensorState = {
  zones: { zone: Zone; added: number; opened: number }[];
  recent_obs: ObsLite[];
  pending_intents: number;
};

const ZONE_EMOJI: Partial<Record<Zone, string>> = {
  library: "📚",
  septic: "⚠️",
  workshop: "🔧",
  yenhub: "🏗",
  writing: "✍️",
  trading: "💹",
  queue: "📥",
};

export function SensorStrip() {
  const [state, setState] = useState<SensorState | null>(null);

  const load = useCallback(async () => {
    try {
      const [attRes, obsRes, intRes] = await Promise.all([
        tokenFetch("/api/vault/attention?days=7"),
        tokenFetch("/api/observations/unread-high"),
        tokenFetch("/api/intents?status=pending"),
      ]);

      const att = attRes.ok ? ((await attRes.json()) as AttentionResponse) : null;
      const obs = obsRes.ok
        ? ((await obsRes.json()) as {
            count: number;
            top: { id: string; title: string }[];
          })
        : null;
      const ints = intRes.ok
        ? ((await intRes.json()) as { intents: unknown[] })
        : null;

      const zones = (att?.zones ?? [])
        .slice()
        .sort((a, b) => b.added - a.added)
        .slice(0, 3)
        .map((z) => ({ zone: z.zone, added: z.added, opened: z.opened }));

      setState({
        zones,
        recent_obs: (obs?.top ?? []).slice(0, 3),
        pending_intents: ints?.intents?.length ?? 0,
      });
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!state) {
    return (
      <div className="mb-10 h-[44px] rounded border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)]" />
    );
  }

  return (
    <div
      className="mb-10 grid grid-cols-1 md:grid-cols-3 gap-px rounded overflow-hidden"
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {/* ── Cell 1 — Attention pulse ─────────────────────────────── */}
      <Cell label="此刻注意力">
        {state.zones.length === 0 ? (
          <span className="text-[var(--fg-3)]">—</span>
        ) : (
          <div className="flex items-center gap-3">
            {state.zones.map((z) => (
              <div
                key={z.zone}
                className="flex items-center gap-1.5"
                title={`${z.zone}: 進 ${z.added} / 翻 ${z.opened}`}
              >
                <span>{ZONE_EMOJI[z.zone] ?? "•"}</span>
                <span className="text-[var(--fg-1)]">{z.added}</span>
                <span className="text-[var(--fg-3)]">/{z.opened}</span>
              </div>
            ))}
          </div>
        )}
      </Cell>

      {/* ── Cell 2 — Recent observations ─────────────────────────── */}
      <Cell label="最近觀察">
        {state.recent_obs.length === 0 ? (
          <span className="text-[var(--fg-3)]">無</span>
        ) : (
          <div className="flex flex-col gap-0.5 w-full overflow-hidden">
            {state.recent_obs.map((o) => (
              <div
                key={o.id}
                className="text-[var(--fg-1)] truncate"
                title={o.title}
              >
                · {o.title}
              </div>
            ))}
          </div>
        )}
      </Cell>

      {/* ── Cell 3 — Pending intents ─────────────────────────────── */}
      <Cell label="待批准">
        {state.pending_intents === 0 ? (
          <span className="text-[var(--fg-3)]">無</span>
        ) : (
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: "var(--warn)",
                boxShadow: "0 0 6px var(--warn)",
              }}
            />
            <span className="text-[var(--warn)] font-mono">
              {state.pending_intents}
            </span>
            <span className="text-[var(--fg-2)]">張卡待你處理</span>
          </div>
        )}
      </Cell>
    </div>
  );
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="px-4 py-2 flex items-center gap-3"
      style={{ background: "var(--bg-0)" }}
    >
      <div className="text-[9px] font-mono tracking-[0.28em] uppercase text-[var(--fg-3)] shrink-0 w-[68px]">
        {label}
      </div>
      <div className="text-[11px] flex items-center min-h-[18px] flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}
