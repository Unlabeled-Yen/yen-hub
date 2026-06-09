"use client";

/**
 * AutoPilotToggle — Slice 12 Phase 4.
 *
 * Sits under TrustDial in the 04 信任分層 section. Two things:
 *   - A toggle switch for `trust-config.auto_pilot`.
 *   - When auto-pilot has done anything, a small audit log of the last 5
 *     actions (kind / direction / when / one-line reason). When it hasn't
 *     done anything yet, just a quiet "尚未動作" line.
 *
 * Flipping ON triggers an immediate evaluation pass so the user sees
 * first-run effects without waiting 24h. The runner has its own 24h
 * internal cooldown after that.
 */

import { useCallback, useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type Action = {
  ts: number;
  kind: string;
  from_tier: "L0" | "L1" | "L2";
  to_tier: "L0" | "L1" | "L2";
  direction: "upgrade" | "downgrade";
  reason: string;
  stats_snapshot: {
    total: number;
    approve_rate: number;
    undo_rate: number;
  };
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

function formatWhen(ms: number, now: number): string {
  const diff = now - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

export function AutoPilotToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lastRun, setLastRun] = useState<number | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const [cfgRes, actRes] = await Promise.all([
        tokenFetch("/api/trust-config"),
        tokenFetch("/api/auto-pilot/actions?limit=5"),
      ]);
      if (cfgRes.ok) {
        const c = (await cfgRes.json()) as {
          auto_pilot: boolean;
          auto_pilot_last_run: number | null;
        };
        setEnabled(c.auto_pilot);
        setLastRun(c.auto_pilot_last_run);
      }
      if (actRes.ok) {
        const a = (await actRes.json()) as { actions: Action[] };
        setActions(a.actions);
      }
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const onToggle = async () => {
    if (enabled === null || busy) return;
    setBusy(true);
    try {
      await tokenFetch("/api/auto-pilot/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) {
    return (
      <div className="mt-5 text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
        loading…
      </div>
    );
  }

  return (
    <div className="mt-6 pt-5 border-t border-[var(--border-subtle)]">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-[var(--fg-0)]">
            Auto-pilot Trust
          </div>
          <div className="text-[11px] text-[var(--fg-2)] mt-1 leading-relaxed">
            打開後 Duffy 自己升降 tier、不再透過 banner 提案。
            {enabled && lastRun
              ? ` · 上次評估 ${formatWhen(lastRun, now)}`
              : ""}
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          aria-label={enabled ? "停用 auto-pilot" : "啟用 auto-pilot"}
          className="shrink-0 relative inline-flex h-[22px] w-[40px] rounded-full transition-colors disabled:opacity-40"
          style={{
            background: enabled ? "var(--accent)" : "rgba(255,255,255,0.10)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <span
            className="inline-block h-[16px] w-[16px] rounded-full bg-white transition-transform"
            style={{
              transform: enabled ? "translateX(20px)" : "translateX(2px)",
              marginTop: "2px",
            }}
          />
        </button>
      </div>

      {/* Audit log — only when there's history */}
      {actions.length > 0 && (
        <div className="mt-4">
          <div className="text-[9px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)] mb-2">
            近期動作 · {actions.length}
          </div>
          <ul className="flex flex-col gap-1">
            {actions.map((a, idx) => (
              <li
                key={`${a.ts}-${idx}`}
                className="flex items-center gap-2 text-[11px]"
              >
                <span
                  className="font-mono text-[9px] tracking-[0.18em] uppercase"
                  style={{
                    color:
                      a.direction === "upgrade"
                        ? "var(--accent)"
                        : "var(--warn)",
                  }}
                  title={a.reason}
                >
                  {a.direction === "upgrade" ? "↑" : "↓"}
                </span>
                <span className="text-[var(--fg-1)] truncate flex-1" title={a.reason}>
                  {KIND_LABEL[a.kind] ?? a.kind} {a.from_tier}→{a.to_tier}
                </span>
                <span className="shrink-0 text-[9px] font-mono tabular-nums text-[var(--fg-3)]">
                  {formatWhen(a.ts, now || Date.now())}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* No-history state when enabled */}
      {enabled && actions.length === 0 && (
        <div className="mt-4 text-[11px] text-[var(--fg-2)]">
          尚未動作 · 訊號累積夠才會出手
        </div>
      )}
    </div>
  );
}
