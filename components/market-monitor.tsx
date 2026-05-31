"use client";

/**
 * MarketMonitor — top-right of Page A.
 *
 * Currently shows US30 (Dow Jones Industrial Average via Yahoo ^DJI):
 *   - large price, day change + percent, market state chip
 *   - intraday sparkline (5m closes, last ~78 points = US session day)
 *   - 60s polling
 *
 * VIX + 波動率 slots are still reserved underneath — wire when ready.
 */

import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

const EASE: [number, number, number, number] = [0.075, 0.82, 0.165, 1];

type Quote = {
  symbol: string;
  price: number;
  prev: number;
  change: number;
  changePct: number;
  series: number[];
  marketState: string;
  updatedAt: number;
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

function buildSparkline(series: number[], w: number, h: number): string {
  if (series.length < 2) return "";
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const stepX = w / (series.length - 1);
  return series
    .map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / span) * h;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function stateLabel(s: string): string {
  switch (s) {
    case "PRE":
      return "PRE";
    case "REGULAR":
      return "OPEN";
    case "POST":
    case "POSTPOST":
      return "AFTER";
    default:
      return "CLOSE";
  }
}

export function MarketMonitor() {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const r = await fetch("/api/market/us30", {
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
  }, []);

  const isUp = (quote?.change ?? 0) >= 0;
  const accent = isUp
    ? "rgba(120, 220, 160, 0.95)" // soft green
    : "rgba(255, 110, 90, 0.95)"; // warm red

  const sparkW = 360;
  const sparkH = 60;
  const sparkPath = useMemo(
    () => (quote ? buildSparkline(quote.series, sparkW, sparkH) : ""),
    [quote],
  );

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
          border: `1px solid ${isUp ? "rgba(120,220,160,0.18)" : "rgba(255,110,90,0.18)"}`,
          background:
            "linear-gradient(180deg, rgba(255,184,120,0.04) 0%, rgba(255,184,120,0) 100%)",
          padding: "20px 22px",
          gap: 10,
        }}
      >
        {/* US30 block */}
        <div className="flex items-baseline justify-between gap-4">
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
          {quote ? (
            <span
              className="text-[9px] tracking-[0.22em] uppercase"
              style={{ color: "var(--fg-2)" }}
            >
              {stateLabel(quote.marketState)}
            </span>
          ) : null}
        </div>

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

        {/* Sparkline */}
        <div
          style={{
            marginTop: 4,
            width: "100%",
            height: sparkH,
            position: "relative",
          }}
        >
          {sparkPath ? (
            <svg
              width="100%"
              height={sparkH}
              viewBox={`0 0 ${sparkW} ${sparkH}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              <defs>
                <linearGradient
                  id="us30-fill"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={accent} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <motion.path
                d={`${sparkPath} L ${sparkW} ${sparkH} L 0 ${sparkH} Z`}
                fill="url(#us30-fill)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8, ease: EASE }}
              />
              <motion.path
                d={sparkPath}
                fill="none"
                stroke={accent}
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.1, ease: [0.22, 0.9, 0.36, 1] }}
                style={{
                  filter: `drop-shadow(0 0 4px ${accent.replace("0.95", "0.40")})`,
                }}
              />
            </svg>
          ) : (
            <div
              className="text-[10px] tracking-[0.28em] uppercase"
              style={{ color: "var(--fg-2)", opacity: 0.55 }}
            >
              {err ? `error · ${err}` : "loading"}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-between text-[9px] tracking-[0.20em] uppercase mt-1"
          style={{ color: "var(--fg-2)", opacity: 0.55 }}
        >
          <span>Yahoo · ^DJI · 5m</span>
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
          className="mt-auto pt-4 border-t border-white/[0.04] flex items-center gap-4 text-[10px] tracking-[0.22em] uppercase"
          style={{ color: "var(--fg-2)", opacity: 0.55 }}
        >
          <span>VIX —</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>波動率 —</span>
          <span
            className="ml-auto text-[9px]"
            style={{ opacity: 0.65 }}
          >
            待接
          </span>
        </div>
      </motion.div>
    </section>
  );
}
