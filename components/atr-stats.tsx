/**
 * AtrStats — US30 (DJI cash proxy via DIA × 100) volatility +
 * direction-efficiency snapshot. Computes a 7-field bundle per
 * timeframe (D + 2H):
 *
 *   atr          ATR(14) using Wilder smoothing (TradingView default)
 *   atrPct       atr / lastClose × 100   (Normalized ATR / Relative
 *                Volatility / ATR Ratio; cross-asset comparable)
 *   atrBaseline  SMA(atr, 24) — recent ATR baseline
 *   rvol         atr / atrBaseline — relative volatility expansion
 *   er           Kaufman Efficiency Ratio over 14 closes (0..1; 1 =
 *                pure directional move, 0 = pure chop)
 *   score        rvol × er — combined signal magnitude
 *   tradeable    rvol ≥ 1.5 AND er ≥ 0.4 — gating rule per the spec
 *
 * Output is read-only: the snapshot doesn't react to the main chart's
 * timeframe and updates on its own 60s interval.
 */

"use client";

import { useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type Candle = { t: number; o: number; h: number; l: number; c: number };
type Quote = { candles: Candle[] };
type Timeframe = "1d" | "2h";

type Params = {
  atrPeriod: number; // n
  baselinePeriod: number; // m
  erPeriod: number; // p
  smoothing: "wilder" | "sma";
  rvolThreshold: number;
  erThreshold: number;
};

const DEFAULT_PARAMS: Params = {
  atrPeriod: 14,
  baselinePeriod: 24,
  erPeriod: 14,
  smoothing: "wilder",
  rvolThreshold: 1.5,
  erThreshold: 0.4,
};

type VolStats = {
  atr: number | null;
  atrPct: number | null;
  atrBaseline: number | null;
  rvol: number | null;
  er: number | null;
  score: number | null;
  tradeable: boolean;
};

const EMPTY_STATS: VolStats = {
  atr: null,
  atrPct: null,
  atrBaseline: null,
  rvol: null,
  er: null,
  score: null,
  tradeable: false,
};

/** Sanitize numbers — anything non-finite collapses to null so NaN never
 *  leaks out into the UI. */
function safe(v: number | null): number | null {
  return v !== null && Number.isFinite(v) ? v : null;
}

function computeVolStats(
  candles: Candle[],
  params: Params = DEFAULT_PARAMS,
): VolStats {
  const { atrPeriod: n, baselinePeriod: m, erPeriod: p, smoothing } = params;
  const N = candles.length;
  if (N < n + m) return EMPTY_STATS;

  // 1) True Range — TR[i] is for candles[i+1] (TR length = N-1).
  const TR: number[] = new Array(N - 1);
  for (let i = 1; i < N; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    TR[i - 1] = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c),
    );
  }
  if (TR.length < n) return EMPTY_STATS;

  // 2) ATR series.
  const atrSeries: number[] = [];
  if (smoothing === "wilder") {
    // Wilder / RMA: seed = SMA of first n TRs; thereafter ATR[i] =
    // (ATR[i-1]*(n-1) + TR[i]) / n.
    let seed = 0;
    for (let i = 0; i < n; i++) seed += TR[i];
    atrSeries.push(seed / n);
    for (let i = n; i < TR.length; i++) {
      const prev = atrSeries[atrSeries.length - 1];
      atrSeries.push((prev * (n - 1) + TR[i]) / n);
    }
  } else {
    // Rolling n-period simple average.
    for (let i = n - 1; i < TR.length; i++) {
      let sum = 0;
      for (let j = i - n + 1; j <= i; j++) sum += TR[j];
      atrSeries.push(sum / n);
    }
  }
  if (atrSeries.length === 0) return EMPTY_STATS;

  const atr = safe(atrSeries[atrSeries.length - 1]);
  if (atr === null) return EMPTY_STATS;

  // 3) atrBaseline = SMA(ATR, m). Spec requires at least m ATR values.
  if (atrSeries.length < m) return { ...EMPTY_STATS, atr };
  let baselineSum = 0;
  for (let i = atrSeries.length - m; i < atrSeries.length; i++) {
    baselineSum += atrSeries[i];
  }
  const atrBaseline = safe(baselineSum / m);

  // 4) rvol = atr / atrBaseline; null if baseline is 0/null.
  const rvol =
    atrBaseline === null || atrBaseline === 0 ? null : safe(atr / atrBaseline);

  // 5) atrPct = atr / lastClose × 100.
  const lastClose = candles[N - 1]?.c;
  const atrPct =
    typeof lastClose === "number" && lastClose !== 0
      ? safe((atr / lastClose) * 100)
      : null;

  // 6) Efficiency Ratio over p closes.
  //    netChange  = |c[N-1] - c[N-1-p]|
  //    pathLength = Σ |c[k] - c[k-1]|  for k = N-p .. N-1   (p increments)
  let er: number | null = null;
  if (N >= p + 1) {
    const netChange = Math.abs(candles[N - 1].c - candles[N - 1 - p].c);
    let pathLength = 0;
    for (let k = N - p; k < N; k++) {
      pathLength += Math.abs(candles[k].c - candles[k - 1].c);
    }
    er = pathLength > 0 ? safe(netChange / pathLength) : null;
  }

  // 7) score = rvol × er when both available.
  const score = rvol !== null && er !== null ? safe(rvol * er) : null;

  // 8) tradeable gate.
  const tradeable =
    rvol !== null &&
    er !== null &&
    rvol >= params.rvolThreshold &&
    er >= params.erThreshold;

  return { atr, atrPct, atrBaseline, rvol, er, score, tradeable };
}

function fmtAtr(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(0);
}
function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(2)}%`;
}
function fmtRatio(v: number | null, digits = 2): string {
  if (v === null) return "—";
  return v.toFixed(digits);
}

type Row = { tf: Timeframe; label: string; stats: VolStats };

export function AtrStats() {
  const [rows, setRows] = useState<Row[]>([
    { tf: "1d", label: "D", stats: EMPTY_STATS },
    { tf: "2h", label: "2H", stats: EMPTY_STATS },
  ]);

  useEffect(() => {
    let cancelled = false;
    async function pullOne(tf: Timeframe, label: string): Promise<Row> {
      try {
        const r = await tokenFetch(`/api/market/us30?tf=${tf}`, {
          credentials: "same-origin",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Quote;
        return { tf, label, stats: computeVolStats(j.candles) };
      } catch {
        return { tf, label, stats: EMPTY_STATS };
      }
    }
    async function pull() {
      const [d, h] = await Promise.all([pullOne("1d", "D"), pullOne("2h", "2H")]);
      if (!cancelled) setRows([d, h]);
    }
    pull();
    const id = setInterval(pull, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <section
      aria-label="US30 volatility snapshot"
      className="font-mono select-none"
      style={{ color: "var(--fg-2)" }}
    >
      <header
        className="text-[10px] tracking-[0.26em] uppercase mb-2 flex items-baseline gap-3"
        style={{ color: "var(--fg-1)" }}
      >
        <span>US30</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span style={{ opacity: 0.85 }}>Vol(14) Wilder</span>
      </header>
      {/* Column headers — match the row grid below. */}
      <div
        className="grid items-baseline gap-x-2 mb-1 text-[9px] tracking-[0.18em] uppercase"
        style={{
          gridTemplateColumns: "24px 1fr 1fr 1fr 1fr 12px",
          opacity: 0.55,
        }}
      >
        <span />
        <span className="text-right">ATR</span>
        <span className="text-right">%</span>
        <span className="text-right">RVOL</span>
        <span className="text-right">ER</span>
        <span />
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const s = r.stats;
          const rvolHot =
            s.rvol !== null && s.rvol >= DEFAULT_PARAMS.rvolThreshold;
          const erHot =
            s.er !== null && s.er >= DEFAULT_PARAMS.erThreshold;
          return (
            <div
              key={r.tf}
              className="grid items-baseline gap-x-2"
              style={{ gridTemplateColumns: "24px 1fr 1fr 1fr 1fr 12px" }}
              title={
                s.atrBaseline !== null
                  ? `ATR baseline (SMA${DEFAULT_PARAMS.baselinePeriod}) = ${s.atrBaseline.toFixed(2)}\n` +
                    `score (rvol × er) = ${s.score === null ? "—" : s.score.toFixed(2)}`
                  : undefined
              }
            >
              <span
                className="text-[10px] tracking-[0.20em] uppercase"
                style={{ color: "var(--fg-1)" }}
              >
                {r.label}
              </span>
              <span
                className="text-[11px] tabular-nums text-right"
                style={{ color: "var(--fg-0)" }}
              >
                {fmtAtr(s.atr)}
              </span>
              <span
                className="text-[10px] tabular-nums text-right"
                style={{ color: "rgba(255,184,120,0.85)" }}
              >
                {fmtPct(s.atrPct)}
              </span>
              <span
                className="text-[10px] tabular-nums text-right"
                style={{
                  color: rvolHot
                    ? "rgba(255,110,70,0.95)"
                    : "rgba(255,255,255,0.55)",
                }}
              >
                {fmtRatio(s.rvol)}
              </span>
              <span
                className="text-[10px] tabular-nums text-right"
                style={{
                  color: erHot
                    ? "rgba(140,220,170,0.95)"
                    : "rgba(255,255,255,0.55)",
                }}
              >
                {fmtRatio(s.er)}
              </span>
              <span
                className="text-[10px] text-center"
                style={{
                  color: s.tradeable
                    ? "rgba(140,220,170,0.95)"
                    : "rgba(255,255,255,0.20)",
                }}
                aria-label={s.tradeable ? "tradeable" : "not tradeable"}
              >
                {s.tradeable ? "✓" : "·"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
