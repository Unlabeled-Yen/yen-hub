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

const EASE: [number, number, number, number] = [0.075, 0.82, 0.165, 1];

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
  source?: "twelvedata" | "stooq";
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

export function MarketMonitor() {
  const [tf, setTf] = useState<Timeframe>("1d");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const r = await fetch(`/api/market/us30?tf=${tf}`, {
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
      className="font-mono flex flex-col h-full"
      aria-label="market monitor"
      data-tauri-drag-region
    >
      <header className="flex items-center gap-3 text-[11px] tracking-[0.30em] uppercase text-[var(--fg-2)] mb-4 flex-shrink-0">
        <span>Market</span>
        <span style={{ opacity: 0.4 }}>—</span>
        <span style={{ opacity: 0.6 }}>US30 · VIX · 波動率</span>
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
          minHeight: 360,
          borderRadius: 6,
          border: `1px solid ${accentDim}`,
          background: `linear-gradient(180deg, ${accent.replace("0.95", "0.04")} 0%, transparent 100%)`,
          padding: "20px 22px",
          gap: 12,
        }}
      >
        {/* Top row: symbol + state + timeframe switcher */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <span
              className="text-[11px] tracking-[0.30em] uppercase"
              style={{ color: "rgba(255,184,120,0.85)" }}
            >
              US30
            </span>
            <span
              className="text-[9px] tracking-[0.22em] uppercase"
              style={{ color: "var(--fg-2)", opacity: 0.7 }}
            >
              DJIA · ^DJI
            </span>
          </div>
          <div className="flex items-center gap-3">
            {/* Timeframe tabs moved into a vertical strip alongside the
                chart below — keep just the stale indicator here. */}
            {quote?.stale ? (
              <span
                title="stale (upstream rate-limited)"
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: "rgba(255,180,80,0.85)",
                  boxShadow: "0 0 6px rgba(255,180,80,0.5)",
                }}
              />
            ) : null}
          </div>
        </div>

        {/* Price + change row */}
        <div className="flex items-end justify-between gap-6">
          <div className="flex items-baseline gap-3 min-w-0">
            <span
              className="tabular-nums"
              style={{
                fontSize: 28,
                fontWeight: 600,
                color: "var(--fg-0)",
                letterSpacing: "0.02em",
                textShadow: `0 0 12px ${accent.replace("0.95", "0.25")}`,
              }}
            >
              {quote ? fmtPrice.format(quote.price) : "—"}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 tabular-nums">
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: accent,
              }}
            >
              {quote ? fmtChange.format(quote.change) : "—"}
            </span>
            <span
              className="text-[11px]"
              style={{ color: accent, opacity: 0.85 }}
            >
              {quote ? `${fmtPct.format(quote.changePct)}%` : ""}
            </span>
          </div>
        </div>

        {/* Candle chart — tabs moved outside the panel (see below). */}
        <div className="flex-1 min-h-0 flex flex-col">
          {quote && quote.candles.length > 0 ? (
            <CandleChart
              candles={quote.candles}
              timeframe={quote.timeframe}
              height={200}
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

        <div
          className="flex items-center justify-between text-[9px] tracking-[0.20em] uppercase"
          style={{ color: "var(--fg-2)", opacity: 0.55 }}
        >
          <span>
            {quote?.source === "stooq"
              ? `Stooq · ^DJI · ${tf}`
              : `Twelve Data · DIA×100 · ${tf}`}
          </span>
          <span>
            {quote
              ? new Date(quote.updatedAt).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "America/New_York",
                }) + " NY"
              : ""}
          </span>
        </div>

        {/* VIX + 波動率 — still reserved */}
        <div
          className="pt-3 border-t border-white/[0.04] flex items-center gap-4 text-[10px] tracking-[0.22em] uppercase"
          style={{ color: "var(--fg-2)", opacity: 0.55 }}
        >
          <span>VIX —</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>波動率 —</span>
          <span className="ml-auto text-[9px]" style={{ opacity: 0.65 }}>
            待接
          </span>
        </div>
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
            top: 96,
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
