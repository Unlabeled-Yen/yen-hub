"use client";

/**
 * TokenUsageBar — Slice 元能力 #1.
 *
 * Sits in 04 信任分層 alongside the other knobs. Shows today's total LLM
 * token usage with an optional budget bar. If no budget is set, displays
 * "no limit". Click the number to set / clear a budget via inline input.
 *
 * Updates every 30s (polling). v1 is observability only — no enforcement.
 * If usage > budget the bar goes red but Duffy still works.
 */

import { useCallback, useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type UsageResponse = {
  today: {
    total: number;
    input: number;
    output: number;
    count: number;
    by_call_site: Record<string, number>;
    by_model: Record<string, number>;
  };
  budget: number | null;
  budget_pct: number | null;
};

const POLL_MS = 30_000;

const CALL_SITE_LABEL: Record<string, string> = {
  "duffy-chat": "對話",
  "coach-card": "今日卡",
  "summary-cron": "週摘要",
  "headless-telegram": "Telegram",
  "nudge-draft": "醒提",
  bootstrap: "初始化",
  other: "其他",
};

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function TokenUsageBar() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/token-usage");
      if (!res.ok) return;
      const d = (await res.json()) as UsageResponse;
      setData(d);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const submitBudget = async (clear?: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const budget = clear ? null : parseInt(input.replace(/[,\s]/g, ""), 10);
      if (!clear && (!Number.isFinite(budget!) || budget! <= 0)) {
        setBusy(false);
        return;
      }
      await tokenFetch("/api/token-usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ budget: clear ? null : budget }),
      });
      await load();
      setEditing(false);
      setInput("");
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;

  const { today, budget, budget_pct } = data;
  const overBudget = budget_pct !== null && budget_pct >= 100;
  const warningBudget = budget_pct !== null && budget_pct >= 80 && !overBudget;

  const barColor = overBudget
    ? "var(--warn)"
    : warningBudget
      ? "rgba(255, 181, 71, 0.8)"
      : "var(--accent)";

  return (
    <div className="mt-5 pt-4 border-t border-[var(--border-subtle)]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3 mb-1">
            <span className="text-[12px] text-[var(--fg-0)]">用量</span>
            <span className="text-[10px] font-mono tabular-nums text-[var(--fg-2)]">
              今日 {formatNum(today.total)}
              {budget ? ` / ${formatNum(budget)}` : ""}
              {budget_pct !== null && ` · ${Math.round(budget_pct)}%`}
            </span>
            {today.count > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-[9px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)] hover:text-[var(--fg-1)]"
              >
                {expanded ? "收起" : "細分"}
              </button>
            )}
          </div>
          {/* Bar */}
          {budget ? (
            <div
              className="h-[6px] rounded overflow-hidden"
              style={{ background: "rgba(255,255,255,0.06)" }}
            >
              <div
                className="h-full transition-[width,background]"
                style={{
                  width: `${Math.min(100, budget_pct ?? 0)}%`,
                  background: barColor,
                }}
              />
            </div>
          ) : (
            <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
              未設預算 · 純監看
            </div>
          )}
        </div>

        {/* Edit budget button */}
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setInput(budget ? String(budget) : "");
            }}
            className="shrink-0 text-[9px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)] hover:text-[var(--fg-1)]"
          >
            {budget ? "改" : "設預算"}
          </button>
        )}
      </div>

      {/* Inline budget editor */}
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="100000"
            className="flex-1 px-2 py-1 text-[11px] font-mono rounded border bg-transparent text-[var(--fg-0)]"
            style={{ borderColor: "var(--border-subtle)" }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => submitBudget()}
            className="px-2 py-1 text-[9px] font-mono tracking-[0.18em] uppercase rounded border text-[var(--accent)]"
            style={{ borderColor: "var(--accent)" }}
          >
            存
          </button>
          {budget !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => submitBudget(true)}
              className="px-2 py-1 text-[9px] font-mono tracking-[0.18em] uppercase rounded border text-[var(--fg-3)]"
              style={{ borderColor: "rgba(255,255,255,0.10)" }}
            >
              清除
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setInput("");
            }}
            className="text-[9px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]"
          >
            取消
          </button>
        </div>
      )}

      {/* Expanded breakdown */}
      {expanded && today.count > 0 && (
        <div className="mt-3 text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
          <div className="mb-1">細分</div>
          <ul className="flex flex-col gap-0.5">
            {Object.entries(today.by_call_site)
              .sort(([, a], [, b]) => b - a)
              .map(([cs, n]) => (
                <li key={cs} className="flex justify-between gap-2">
                  <span>{CALL_SITE_LABEL[cs] ?? cs}</span>
                  <span className="text-[var(--fg-1)] tabular-nums">
                    {formatNum(n)}
                  </span>
                </li>
              ))}
          </ul>
          <div className="mt-2">{today.count} 次呼叫 · 輸入 {formatNum(today.input)} / 輸出 {formatNum(today.output)}</div>
        </div>
      )}
    </div>
  );
}
