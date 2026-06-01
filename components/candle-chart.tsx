"use client";

/**
 * CandleChart — self-drawn OHLC candlestick chart in the Yen Hub aesthetic.
 *
 * Visual rules (intentional, not configurable):
 *   - Up candle (close ≥ open): warm cream (rgba(255,184,120,…)), filled body
 *   - Down candle (close < open): deep red (rgba(255,90,80,…)), filled body
 *   - Wicks: 1px vertical line from high to low in the candle's color
 *   - Right axis: 2-3 price labels (max / mid / min), small mono, fg-2
 *   - Bottom axis: 2 time labels (first / last), small mono, fg-2
 *   - Hover crosshair: thin dashed lines + OHLC tooltip top-right
 *
 * Pure SVG, no chart library. Sized to fill parent — responsive via
 * ResizeObserver. Animation: candles fade in left-to-right on first paint.
 */

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

export type Candle = { t: number; o: number; h: number; l: number; c: number };

const PAD_L = 8;
const PAD_R = 56; // room for price labels on the right
const PAD_T = 8;
const PAD_B = 18; // room for time labels at the bottom

const UP_COLOR = "rgba(255,184,120,0.95)";
const UP_FILL = "rgba(255,184,120,0.75)";
const DOWN_COLOR = "rgba(255,95,85,0.95)";
const DOWN_FILL = "rgba(255,95,85,0.75)";
const GRID = "rgba(255,255,255,0.05)";
const AXIS_FG = "rgba(180,180,180,0.55)";

function fmtPrice(n: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtTimeForTf(t: number, tf: "15m" | "2h" | "1d"): string {
  const d = new Date(t);
  if (tf === "1d") {
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      timeZone: "America/New_York",
    });
  }
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  });
}

export function CandleChart({
  candles,
  timeframe,
  height = 200,
}: {
  candles: Candle[];
  timeframe: "15m" | "2h" | "1d";
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (candles.length === 0) return null;
    const plotW = Math.max(0, width - PAD_L - PAD_R);
    const plotH = Math.max(0, height - PAD_T - PAD_B);
    const n = candles.length;
    // Candle width: leave 30% as gap. Floor at 1.5px so they don't vanish.
    const slot = plotW / n;
    const bodyW = Math.max(1.5, Math.min(slot * 0.7, 10));
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of candles) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi === lo) {
      // Single-candle degenerate case (Stooq fallback): expand range slightly
      // so the candle isn't a flat zero-height line.
      const c = candles[0];
      hi = Math.max(c.h, c.c, c.o);
      lo = Math.min(c.l, c.c, c.o);
      if (hi === lo) {
        hi += 1;
        lo -= 1;
      }
    }
    const range = hi - lo;
    const pricePad = range * 0.05;
    const yMax = hi + pricePad;
    const yMin = lo - pricePad;
    const ySpan = yMax - yMin;

    const xOf = (i: number) => PAD_L + slot * (i + 0.5);
    const yOf = (price: number) =>
      PAD_T + ((yMax - price) / ySpan) * plotH;

    return { plotW, plotH, slot, bodyW, yMax, yMin, ySpan, xOf, yOf };
  }, [candles, width, height]);

  if (!layout || candles.length === 0) {
    return (
      <div
        ref={wrapRef}
        style={{ width: "100%", height }}
        className="flex items-center justify-center font-mono text-[10px] tracking-[0.28em] uppercase"
      >
        <span style={{ color: AXIS_FG }}>loading</span>
      </div>
    );
  }

  const { yMax, yMin, ySpan, xOf, yOf, bodyW } = layout;
  const mid = (yMax + yMin) / 2;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!layout) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const slot = layout.slot;
    const idx = Math.floor((x - PAD_L) / slot);
    if (idx >= 0 && idx < candles.length) {
      setHoverIdx(idx);
    } else {
      setHoverIdx(null);
    }
  }

  const hovered = hoverIdx !== null ? candles[hoverIdx] : null;
  const hoverX = hoverIdx !== null ? xOf(hoverIdx) : null;
  const hoverY =
    hovered && hoverX !== null ? yOf(hovered.c) : null;

  // Last candle separator color → drives subtle border tint on the chart
  // frame.
  const last = candles[candles.length - 1];
  const lastUp = last.c >= last.o;
  const accent = lastUp ? UP_COLOR : DOWN_COLOR;

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: "100%",
        height,
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        style={{ cursor: "crosshair", display: "block" }}
      >
        {/* Horizontal grid: top / mid / bottom */}
        {[yMax, mid, yMin].map((p, i) => (
          <line
            key={`g-${i}`}
            x1={PAD_L}
            x2={width - PAD_R}
            y1={yOf(p)}
            y2={yOf(p)}
            stroke={GRID}
            strokeWidth={1}
            strokeDasharray={i === 1 ? "2 4" : undefined}
          />
        ))}

        {/* Right-side price labels */}
        {[yMax, mid, yMin].map((p, i) => (
          <text
            key={`pl-${i}`}
            x={width - PAD_R + 6}
            y={yOf(p) + 3}
            fontSize={9}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fill={AXIS_FG}
            letterSpacing="0.04em"
          >
            {fmtPrice(p)}
          </text>
        ))}

        {/* Candles */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? UP_COLOR : DOWN_COLOR;
          const fill = up ? UP_FILL : DOWN_FILL;
          const x = xOf(i);
          const yHigh = yOf(c.h);
          const yLow = yOf(c.l);
          const yOpen = yOf(c.o);
          const yClose = yOf(c.c);
          const bodyY = Math.min(yOpen, yClose);
          const bodyH = Math.max(0.8, Math.abs(yOpen - yClose));
          // Stagger fade-in across the series — total ~700ms, no per-candle
          // wait once the chart is on screen.
          const delay = (i / candles.length) * 0.55;
          return (
            <motion.g
              key={c.t}
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay, ease: "easeOut" }}
            >
              <line
                x1={x}
                x2={x}
                y1={yHigh}
                y2={yLow}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                x={x - bodyW / 2}
                y={bodyY}
                width={bodyW}
                height={bodyH}
                fill={fill}
                stroke={color}
                strokeWidth={0.8}
              />
            </motion.g>
          );
        })}

        {/* Bottom time labels — first & last only, plus middle if there's room */}
        <text
          x={PAD_L}
          y={height - 4}
          fontSize={9}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fill={AXIS_FG}
          letterSpacing="0.06em"
        >
          {fmtTimeForTf(candles[0].t, timeframe)}
        </text>
        <text
          x={width - PAD_R}
          y={height - 4}
          fontSize={9}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fill={AXIS_FG}
          textAnchor="end"
          letterSpacing="0.06em"
        >
          {fmtTimeForTf(candles[candles.length - 1].t, timeframe)}
        </text>

        {/* Hover crosshair + price marker */}
        {hovered && hoverX !== null && hoverY !== null ? (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PAD_T}
              y2={height - PAD_B}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth={0.8}
              strokeDasharray="2 3"
            />
            <line
              x1={PAD_L}
              x2={width - PAD_R}
              y1={hoverY}
              y2={hoverY}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth={0.8}
              strokeDasharray="2 3"
            />
            <text
              x={width - PAD_R + 6}
              y={hoverY + 3}
              fontSize={9.5}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fill={accent}
              fontWeight={600}
            >
              {fmtPrice(hovered.c)}
            </text>
          </g>
        ) : null}
      </svg>

      {/* OHLC tooltip — top-left of the chart, swap to right if mouse is left */}
      {hovered ? (
        <div
          style={{
            position: "absolute",
            top: 4,
            left: 12,
            display: "flex",
            gap: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            letterSpacing: "0.06em",
            color: "var(--fg-1)",
            background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(4px)",
            padding: "3px 8px",
            borderRadius: 3,
            border: "1px solid rgba(255,255,255,0.05)",
            pointerEvents: "none",
          }}
        >
          <span style={{ opacity: 0.6 }}>
            {fmtTimeForTf(hovered.t, timeframe)}
          </span>
          <span>
            <span style={{ opacity: 0.55 }}>O</span> {fmtPrice(hovered.o)}
          </span>
          <span>
            <span style={{ opacity: 0.55 }}>H</span> {fmtPrice(hovered.h)}
          </span>
          <span>
            <span style={{ opacity: 0.55 }}>L</span> {fmtPrice(hovered.l)}
          </span>
          <span style={{ color: hovered.c >= hovered.o ? UP_COLOR : DOWN_COLOR }}>
            <span style={{ opacity: 0.55, color: "var(--fg-1)" }}>C</span>{" "}
            {fmtPrice(hovered.c)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
