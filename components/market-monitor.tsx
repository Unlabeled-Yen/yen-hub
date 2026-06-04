"use client";

/**
 * MarketMonitor — top-right of Page A.
 *
 * US30 candlestick (Yahoo ^DJI, Stooq fallback):
 *   - 5m / 1h / 1d timeframe switcher
 *   - big price + day change/percent + market state
 *   - self-drawn OHLC candle chart (see CandleChart)
 *   - 60s polling per timeframe
 *
 * VIX + 波動率 slots stay reserved underneath.
 */

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { CandleChart, type Candle } from "./candle-chart";
import { EASE } from "@/lib/animation/constants";
import { tokenFetch } from "@/lib/security/sidecar-token";

type Timeframe = "15m" | "2h" | "1d";

type Quote = {
  symbol: string;
  price: number;
  prev: number;
  change: number;
  changePct: number;
  candles: Candle[];
  marketState: string;
  updatedAt: number;
  source?: "yahoo" | "twelvedata" | "stooq";
  timeframe: Timeframe;
  stale?: boolean;
};

const fmtPrice = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtChange = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});
const fmtPct = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "always",
});

const TIMEFRAMES: Timeframe[] = ["15m", "2h", "1d"];

function fmtHoverTime(t: number, tf: Timeframe): string {
  const d = new Date(t);
  if (tf === "1d") {
    // For daily bars, show date only — there's no meaningful "time of day"
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    });
  }
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

export function MarketMonitor() {
  const [tf, setTf] = useState<Timeframe>("1d");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Time of the hovered K bar — set by CandleChart via onHoverChange.
  // Shown in the panel header (outside the bordered card).
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const r = await tokenFetch(`/api/market/us30?tf=${tf}`, {
          credentials: "same-origin",
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const json = (await r.json()) as Quote;
        if (!cancelled) {
          setQuote(json);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    pull();
    const id = setInterval(pull, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tf]);

  const isUp = (quote?.change ?? 0) >= 0;
  // Up = warm orange; down = pale cream-mustard. Matches CandleChart.
  const accent = isUp
    ? "rgba(255,170,100,0.95)"
    : "rgba(235,225,185,0.95)";
  const accentDim = isUp ? "rgba(255,170,100,0.18)" : "rgba(235,225,185,0.18)";

  return (
    <section
      className="relative font-mono flex flex-col h-full"
      aria-label="market monitor"
      data-tauri-drag-region
    >
      {/* NY clock used to mount here at top:-22, but the parent `main`
          has `overflow-y-auto` which clips any child positioned above
          y=0. Moved out to overview's outer flex container (which is
          NOT a scroll container) so it can't be clipped. */}
      <header className="flex items-center gap-3 text-[11px] tracking-[0.30em] uppercase text-[var(--fg-2)] mb-4 flex-shrink-0">
        <span>Market</span>
        <span style={{ opacity: 0.4 }}>—</span>
        <span style={{ opacity: 0.6 }}>US30 · VIX · 波動率</span>
        {hoverTime !== null ? (
          <span
            className="ml-auto text-[10px] tracking-[0.18em]"
            style={{
              color: "rgba(255,184,120,0.95)",
              textShadow: "0 0 6px rgba(255,184,120,0.35)",
            }}
          >
            {fmtHoverTime(hoverTime, tf)}
          </span>
        ) : null}
      </header>

      {/* Panel takes the full width of the section. The tf tab strip
          is positioned ABSOLUTELY outside the panel's right edge (see
          below) so it visually sits next to the card without stealing
          flex space — the US30 area keeps its full width. */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.45, ease: EASE }}
        className="relative flex-1 flex flex-col"
        style={{
          minHeight: 520,
          borderRadius: 6,
          border: `1px solid ${accentDim}`,
          // 2026-06-04: panel's own warm tint removed — Page A's outer
          // motion.div now paints the same warm gradient across the
          // entire viewport, so adding another 0.04 here would double
          // up (panel reads warmer than surroundings).
          background: "transparent",
          // Padding removed so the chart SVG fills the panel
          // border-to-border. The grid lines (drawn from x=0..width and
          // y=0..height inside the SVG) now visually touch the border;
          // previously the 20/22px panel padding left a gap. The
          // chart's own PAD_T/PAD_B/PAD_R reserve the small space
          // needed for axis labels.
          padding: 0,
          gap: 12,
        }}
      >
        {/* Paper-fiber texture removed per Yen — panel returns to the
            plain gradient + border look. */}
        {/* Top US30/DJIA labels + big price-change row removed per spec.
            The chart already exposes the latest price via the right-axis
            colored ribbon, and the panel's accent border / Market header
            communicate context. Stale indicator floats top-right. */}
        {quote?.stale ? (
          <span
            title="stale (upstream rate-limited)"
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: 3,
              background: "rgba(255,180,80,0.85)",
              boxShadow: "0 0 6px rgba(255,180,80,0.5)",
              zIndex: 1,
            }}
          />
        ) : null}

        {/* Candle chart — tabs moved outside the panel (see below). */}
        <div className="flex-1 min-h-0 flex flex-col">
          {quote && quote.candles.length > 0 ? (
            <CandleChart
              candles={quote.candles}
              timeframe={quote.timeframe}
              // 2026-06-04: 360 → 580. Panel is much taller than 360
              // (the candle plot + ATR + Stoch sub-panes now share the
              // SVG and the old number left ~200px of empty space below
              // the chart). 580 fills the panel border-to-border.
              height={580}
              onHoverChange={(c) => setHoverTime(c ? c.t : null)}
            />
          ) : (
            <div
              className="flex-1 flex items-center justify-center text-[10px] tracking-[0.28em] uppercase"
              style={{ color: "var(--fg-2)", opacity: 0.55 }}
            >
              {err ? `error · ${err}` : "loading"}
            </div>
          )}
        </div>

        {/* 2026-06-04 removed:
              - Data-source + NY time row ("Twelve Data · DIA×100 · 1D")
              - VIX / 波動率 / 待接 reserved row
            Per Yen — the panel reads cleaner without these footer
            strips; freshness is still signalled by the top-right stale
            indicator dot, and the NY clock chip in overview's header
            covers the time. */}
        {/* Tab strip — absolutely positioned so it sits OUTSIDE the
            panel's right border (left = 100% + small gap). Doesn't
            consume any flex/grid space, so the US30 panel keeps its
            full width. Single-letter labels D / H / M for compactness.
            top: aligned just below the price row so the strip lines up
            with the chart area. */}
        <nav
          aria-label="timeframe"
          style={{
            position: "absolute",
            left: "calc(100% + 6px)",
            top: 24,
            width: 28,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            zIndex: 2,
          }}
        >
          {TIMEFRAMES.map((t) => {
            const active = t === tf;
            const letter = t === "1d" ? "D" : t === "2h" ? "H" : "M";
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTf(t)}
                className="font-mono"
                style={{
                  width: 28,
                  height: 24,
                  fontSize: 11,
                  letterSpacing: "0.04em",
                  textAlign: "center",
                  color: active ? "var(--fg-0)" : "var(--fg-2)",
                  background: active
                    ? "rgba(255,184,120,0.10)"
                    : "rgba(0,0,0,0.35)",
                  border: "1px solid",
                  borderColor: active
                    ? "rgba(255,184,120,0.40)"
                    : "rgba(255,255,255,0.08)",
                  borderRadius: 3,
                  cursor: "pointer",
                  transition:
                    "color 200ms, background 200ms, border-color 200ms",
                }}
                title={t}
              >
                {letter}
              </button>
            );
          })}
        </nav>
      </motion.div>
    </section>
  );
}
