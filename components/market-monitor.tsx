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
  const accent = isUp
    ? "rgba(255, 184, 120, 0.95)" // warm cream — matches the rest of the Yen Hub up-vibe
    : "rgba(255, 95, 85, 0.95)"; // deep red

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

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.45, ease: EASE }}
        className="relative flex-1 flex flex-col"
        style={{
          minHeight: 360,
          borderRadius: 6,
          border: `1px solid ${isUp ? "rgba(255,184,120,0.18)" : "rgba(255,95,85,0.18)"}`,
          background:
            "linear-gradient(180deg, rgba(255,184,120,0.04) 0%, rgba(255,184,120,0) 100%)",
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
            {/* Timeframe tabs */}
            <div className="flex items-center gap-0.5">
              {TIMEFRAMES.map((t) => {
                const active = t === tf;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTf(t)}
                    className="text-[10px] tracking-[0.18em] uppercase px-2 py-0.5 transition-colors"
                    style={{
                      color: active ? "var(--fg-0)" : "var(--fg-2)",
                      background: active
                        ? "rgba(255,184,120,0.10)"
                        : "transparent",
                      border: "1px solid",
                      borderColor: active
                        ? "rgba(255,184,120,0.35)"
                        : "rgba(255,255,255,0.05)",
                      borderRadius: 2,
                      cursor: "pointer",
                    }}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            {/* Market state chip removed per user request — CLOSE label was
                noisy and PRE/OPEN/AFTER add little vs the price itself.
                Keep just the stale indicator dot when upstream is degraded. */}
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

        {/* Candle chart — flex-grow to fill remaining space */}
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
      </motion.div>
    </section>
  );
}
