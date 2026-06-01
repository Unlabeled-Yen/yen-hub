"use client";

/**
 * CandleChart — self-drawn OHLC candlestick chart in the Yen Hub aesthetic.
 *
 * Interaction:
 *   - Wheel / pinch on chart → zoom in/out, cursor-centered
 *   - Drag on chart → pan left/right through time
 *   - Hover → crosshair + OHLC tooltip with full timestamp
 *   - Double-click → reset zoom to fit all bars
 *
 * Visual:
 *   - Up candle (close ≥ open): warm cream rgba(255,184,120,…) filled
 *   - Down candle (close < open): deep red rgba(255,95,85,…)
 *   - Wicks: 1px vertical line from high to low
 *   - Right axis: 3 price labels (max / mid / min of *visible* range)
 *   - Bottom axis: 5 adaptive time labels across visible range
 *
 * Time handling:
 *   Twelve Data returns timestamps in market-local (NY) time as a string;
 *   the parent encodes that string as if it were UTC ms (see parseTDDatetime
 *   in the API route). So all `toLocaleString` calls below use timeZone:"UTC"
 *   to display the literal NY clock-time without double-converting.
 */

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

export type Candle = { t: number; o: number; h: number; l: number; c: number };

const PAD_L = 8;
const PAD_R = 56;
const PAD_T = 8;
const PAD_B = 20;

const UP_COLOR = "rgba(255,184,120,0.95)";
const UP_FILL = "rgba(255,184,120,0.75)";
const DOWN_COLOR = "rgba(255,95,85,0.95)";
const DOWN_FILL = "rgba(255,95,85,0.75)";
const GRID = "rgba(255,255,255,0.05)";
const AXIS_FG = "rgba(180,180,180,0.55)";

const MIN_VISIBLE = 6;

function fmtPrice(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

function fmtCandleTime(
  t: number,
  tf: "15m" | "2h" | "1d",
  withDate = false,
): string {
  const d = new Date(t);
  if (tf === "1d") {
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    });
  }
  if (withDate) {
    return d.toLocaleString("en-US", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
  }
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

// Pick K well-spaced indices into the visible window for axis ticks.
function pickTickIndices(start: number, end: number, k: number): number[] {
  const n = end - start;
  if (n <= 0) return [];
  if (n < k) return Array.from({ length: n }, (_, i) => start + i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const t = i / (k - 1);
    out.push(Math.round(start + t * (n - 1)));
  }
  return Array.from(new Set(out));
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

  // Visible window [start, end). Reset whenever the underlying series
  // identity changes (parent fetched new tf data).
  const [range, setRange] = useState<[number, number]>([0, candles.length]);
  useEffect(() => {
    setRange([0, candles.length]);
  }, [candles]);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const dragRef = useRef<{
    startX: number;
    startRange: [number, number];
    moved: boolean;
  } | null>(null);

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

  const [start, end] = range;
  const visible = useMemo(
    () => candles.slice(Math.max(0, start), Math.min(candles.length, end)),
    [candles, start, end],
  );

  const layout = useMemo(() => {
    if (visible.length === 0) return null;
    const plotW = Math.max(0, width - PAD_L - PAD_R);
    const plotH = Math.max(0, height - PAD_T - PAD_B);
    const n = visible.length;
    const slot = plotW / n;
    const bodyW = Math.max(1.5, Math.min(slot * 0.7, 12));
    let hi = -Infinity;
    let lo = Infinity;
    for (const c of visible) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi === lo) {
      const c = visible[0];
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
  }, [visible, width, height]);

  // Whether the visible window spans multiple calendar days — drives whether
  // axis ticks include the date prefix or just HH:MM.
  const spansMultipleDays = useMemo(() => {
    if (visible.length < 2) return false;
    const first = new Date(visible[0].t).toISOString().slice(0, 10);
    const last = new Date(visible[visible.length - 1].t)
      .toISOString()
      .slice(0, 10);
    return first !== last;
  }, [visible]);

  if (!layout || visible.length === 0) {
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

  const { yMax, yMin, slot, xOf, yOf, bodyW } = layout;
  const mid = (yMax + yMin) / 2;

  function clientToVisibleIdx(clientX: number, svg: SVGSVGElement): number {
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left;
    const idx = Math.floor((x - PAD_L) / slot);
    return Math.max(0, Math.min(visible.length - 1, idx));
  }

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const candleDelta = -Math.round(dx / slot); // drag right → see older
      if (Math.abs(candleDelta) > 0) dragRef.current.moved = true;
      const [s0, e0] = dragRef.current.startRange;
      const size = e0 - s0;
      let ns = s0 + candleDelta;
      ns = Math.max(0, Math.min(candles.length - size, ns));
      setRange([ns, ns + size]);
      setHoverIdx(null);
      return;
    }
    setHoverIdx(clientToVisibleIdx(e.clientX, e.currentTarget));
  }

  function onMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    dragRef.current = {
      startX: e.clientX,
      startRange: [start, end],
      moved: false,
    };
  }
  function endDrag() {
    dragRef.current = null;
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    // Trackpad pinch reports ctrlKey=true; regular wheel doesn't. Both work.
    const cursorVisibleIdx = clientToVisibleIdx(e.clientX, e.currentTarget);
    const cursorGlobalIdx = start + cursorVisibleIdx;
    const oldSize = end - start;
    const zoomFactor = e.deltaY < 0 ? 0.88 : 1.13; // ←in / out→
    let newSize = Math.round(oldSize * zoomFactor);
    newSize = Math.max(MIN_VISIBLE, Math.min(candles.length, newSize));
    if (newSize === oldSize) return;
    // Keep the cursor's data point at the same screen x.
    const cursorFraction = cursorVisibleIdx / Math.max(1, oldSize - 1);
    let ns = Math.round(cursorGlobalIdx - cursorFraction * (newSize - 1));
    ns = Math.max(0, Math.min(candles.length - newSize, ns));
    setRange([ns, ns + newSize]);
  }

  function onDoubleClick() {
    setRange([0, candles.length]);
  }

  const hovered = hoverIdx !== null ? visible[hoverIdx] : null;
  const hoverX = hoverIdx !== null ? xOf(hoverIdx) : null;
  const hoverY = hovered && hoverX !== null ? yOf(hovered.c) : null;

  const last = visible[visible.length - 1];
  const lastUp = last.c >= last.o;
  const accent = lastUp ? UP_COLOR : DOWN_COLOR;

  // X-axis tick positions in *visible* index space.
  const tickIdxs = pickTickIndices(0, visible.length, 5);

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
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={endDrag}
        onMouseLeave={() => {
          endDrag();
          setHoverIdx(null);
        }}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        style={{
          cursor: dragRef.current ? "grabbing" : "crosshair",
          display: "block",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {/* Horizontal grid */}
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
        {visible.map((c, i) => {
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
          return (
            <motion.g
              key={`${c.t}-${i}`}
              initial={{ opacity: 0.7 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
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

        {/* Bottom time labels — 5 adaptive ticks across visible range */}
        {tickIdxs.map((idx, i) => {
          const c = visible[idx];
          if (!c) return null;
          const x = xOf(idx);
          const isFirst = i === 0;
          const isLast = i === tickIdxs.length - 1;
          const anchor = isFirst ? "start" : isLast ? "end" : "middle";
          return (
            <text
              key={`t-${idx}`}
              x={x}
              y={height - 6}
              fontSize={9}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fill={AXIS_FG}
              textAnchor={anchor}
              letterSpacing="0.04em"
            >
              {fmtCandleTime(c.t, timeframe, spansMultipleDays)}
            </text>
          );
        })}

        {/* Hover crosshair */}
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

      {/* OHLC + time tooltip on hover */}
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
            background: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(4px)",
            padding: "3px 8px",
            borderRadius: 3,
            border: "1px solid rgba(255,255,255,0.06)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: "var(--fg-0)", fontWeight: 600 }}>
            {fmtCandleTime(hovered.t, timeframe, true)}
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

      {/* Subtle bottom-right hint — fades after first interaction would be
          nice but a static cue is fine for now */}
      <div
        style={{
          position: "absolute",
          bottom: 4,
          right: PAD_R + 8,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 8,
          letterSpacing: "0.18em",
          color: AXIS_FG,
          opacity: 0.5,
          pointerEvents: "none",
        }}
      >
        WHEEL · DRAG · 2×CLICK
      </div>
    </div>
  );
}
