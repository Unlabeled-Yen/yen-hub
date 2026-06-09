"use client";

/**
 * TrustDial — Slice 8.7B v1.
 *
 * Three-position slider governing how Duffy's propose-approve gate behaves.
 * Behavior is plumbed through `effectiveAction()` in storage/trust-config.ts;
 * the dial just controls the global mode.
 *
 *   謹慎 — every intent requires approval (default before this slice).
 *   平衡 — L0 auto-executes; L1/L2 require approval. (current default)
 *   奔放 — L0+L1 auto-executes; L2 still gated.
 *
 * Slice 8.7B v2 will add per-tool overrides + L0 auto-execute behavior in
 * the create/decide paths. This v1 is the dial + persistence only —
 * flipping the dial today doesn't yet change what gets auto-executed
 * (that wiring lands in v2 after the auto-execute + undo mechanism).
 */

import { useCallback, useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type Mode = "cautious" | "balanced" | "free";

type Config = {
  mode: Mode;
  updated_at: number;
  stats: { approved: number; rejected: number };
};

const MODES: { key: Mode; label: string; subtitle: string }[] = [
  { key: "cautious", label: "謹慎", subtitle: "全部都要批准" },
  { key: "balanced", label: "平衡", subtitle: "L0 自動 · L1/L2 批准" },
  { key: "free", label: "奔放", subtitle: "L0+L1 自動 · L2 批准" },
];

export function TrustDial() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/trust-config");
      if (!res.ok) return;
      const data = (await res.json()) as Config;
      setCfg(data);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSelect = async (next: Mode) => {
    if (!cfg || cfg.mode === next || busy) return;
    setBusy(true);
    try {
      const res = await tokenFetch("/api/trust-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) {
    return (
      <div className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
        loading…
      </div>
    );
  }

  return (
    <div>
      {/* Stats line */}
      <div className="mb-4 text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
        近 7 天 · 通過 {cfg.stats.approved} / 拒絕 {cfg.stats.rejected}
      </div>

      {/* Three-position dial */}
      <div
        className="grid grid-cols-3 gap-px rounded overflow-hidden"
        style={{
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        {MODES.map((m) => {
          const active = cfg.mode === m.key;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => void onSelect(m.key)}
              disabled={busy || active}
              className="px-4 py-4 flex flex-col items-center gap-1.5 transition-colors disabled:cursor-default"
              style={{
                background: active ? "rgba(0,229,180,0.06)" : "var(--bg-0)",
                color: active ? "var(--accent)" : "var(--fg-2)",
              }}
            >
              <span
                className="text-[12px] tracking-tight"
                style={{ color: active ? "var(--accent)" : "var(--fg-0)" }}
              >
                {m.label}
              </span>
              <span className="text-[9px] font-mono tracking-[0.18em] uppercase">
                {m.subtitle}
              </span>
            </button>
          );
        })}
      </div>

      {/* Behavior hint — what flipping the dial actually does */}
      <div className="mt-3 text-[11px] text-[var(--fg-2)] leading-relaxed">
        旋到「平衡」以上：observation 自動寫入、不彈卡。24h 內可在 02 待辦下方撤銷。
      </div>
    </div>
  );
}
