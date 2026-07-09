"use client";

/**
 * TrendStrip — "熱詞 / 趨勢" bar above the IBM signal cards.
 *
 * Mines article titles for high-frequency terms (from /api/signals/trends).
 * With <2 days of history it shows pure frequency ("熱詞"); once a baseline
 * builds it switches to Z-score trend mode ("趨勢", with ↑↓ direction).
 *
 * Each chip shows the term, its recent count, and a direction arrow. Clicking
 * filters the cards below to titles containing that term (parent handles it).
 */

import { useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type TermTrend = {
  term: string;
  kind: "unigram" | "bigram";
  count: number;
  recentCount: number;
  baseline: number;
  z: number;
  direction: "up" | "flat" | "down";
  sampleTitles: string[];
};

type TrendReport = {
  windowDays: number;
  recentDays: number;
  totalArticles: number;
  daysWithData: number;
  mode: "frequency" | "trend";
  terms: TermTrend[];
  generatedAt: number;
};

function arrow(d: TermTrend["direction"]): string {
  return d === "up" ? "↑" : d === "down" ? "↓" : "·";
}

/** Hot = recent burst (Z ≥ 1, trending up). Drives the accent highlight. */
function isHot(t: TermTrend, mode: TrendReport["mode"]): boolean {
  return mode === "trend" && t.z >= 1 && t.direction === "up";
}

export function TrendStrip({
  selected,
  onSelect,
  reloadKey,
}: {
  selected: string | null;
  onSelect: (term: string | null) => void;
  reloadKey: number;
}) {
  const [report, setReport] = useState<TrendReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await tokenFetch("/api/signals/trends?window=14&recent=3", {
          credentials: "same-origin",
        });
        if (!r.ok) return;
        const json = (await r.json()) as TrendReport;
        if (!cancelled) setReport(json);
      } catch {
        /* strip is optional — silent */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch whenever the parent reloads the cards (new fetch may add history).
  }, [reloadKey]);

  if (!report || report.terms.length === 0) return null;

  const label =
    report.mode === "trend"
      ? `趨勢 · 近 ${report.recentDays} 天 / ${report.windowDays} 天基準`
      : `熱詞 · 今日 ${report.totalArticles} 篇（累積 ${report.daysWithData} 天後顯示趨勢）`;

  return (
    <section className="mb-7">
      <div className="flex items-baseline gap-3 mb-3">
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--accent)]">
          TRENDS
        </span>
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
          {label}
        </span>
        <div className="flex-1 h-px bg-[var(--fg-3)] opacity-30" />
        {selected ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] hover:text-[var(--accent)] transition-colors"
          >
            清除篩選 ✕
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {report.terms.map((t) => {
          const active = selected === t.term;
          const hot = isHot(t, report.mode);
          return (
            <button
              key={t.term}
              type="button"
              onClick={() => onSelect(active ? null : t.term)}
              title={[
                report.mode === "trend"
                  ? `近期 ${t.recentCount} 篇 · 基準 ${t.baseline}/天 · Z=${t.z}`
                  : `出現 ${t.count} 次`,
                ...t.sampleTitles.map((s) => `· ${s}`),
              ].join("\n")}
              className="group flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors"
              style={{
                border: `1px solid ${
                  active
                    ? "var(--accent)"
                    : hot
                      ? "rgba(0,229,180,0.35)"
                      : "var(--fg-3)"
                }`,
                background: active
                  ? "rgba(0,229,180,0.12)"
                  : hot
                    ? "rgba(0,229,180,0.05)"
                    : "transparent",
              }}
            >
              <span
                className="text-[12px]"
                style={{
                  color: active || hot ? "var(--accent)" : "var(--fg-1)",
                }}
              >
                {t.term}
              </span>
              <span className="text-[11px] font-mono text-[var(--fg-2)]">
                {report.mode === "trend" ? t.recentCount : t.count}
              </span>
              {report.mode === "trend" ? (
                <span
                  className="text-[11px] font-mono"
                  style={{
                    color:
                      t.direction === "up"
                        ? "var(--accent)"
                        : t.direction === "down"
                          ? "var(--fg-3)"
                          : "var(--fg-2)",
                  }}
                >
                  {arrow(t.direction)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
