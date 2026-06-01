"use client";

/**
 * CandleChart — TradingView-style candlestick chart.
 *
 * Layout model:
 *   Each candle takes a fixed pixel slot (`candleWidth`). Body/wick scale
 *   uniformly with that, so adjacency *visually never changes* — the same
 *   gap-to-body ratio holds at any zoom level.
 *
 * Interactions:
 *   - Drag main area → pan time (left/right)
 *   - Wheel anywhere → pan time (horizontal scroll)
 *   - Drag bottom time-axis strip ↑ / ↓ → time scale tighter / looser
 *     (i.e. each candle wider / narrower; total visible count adapts)
 *   - Drag right price-axis strip ↑ / ↓ → vertical zoom in / out
 *   - Double-click main → reset both axes (fit all bars)
 *   - Double-click an axis → reset that axis only
 *   - Hover a candle ≥ 2s → "deep hover" pill near cursor with the bar's
 *     full timestamp (in addition to the always-on OHLC strip on top)
 *
 * Time handling:
 *   API encodes NY clock time as UTC ms. All `toLocaleString` here use
 *   timeZone:"UTC" so the displayed label matches the raw NY time.
 */

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

export type Candle = { t: number; o: number; h: number; l: number; c: number };

const PAD_L = 8;
const PAD_R = 56;
const PAD_T = 8;
const PAD_B = 22; // bottom time-axis drag strip lives here

const UP_COLOR = "rgba(255,184,120,0.95)";
const UP_FILL = "rgba(255,184,120,0.75)";
const DOWN_COLOR = "rgba(255,95,85,0.95)";
const DOWN_FILL = "rgba(255,95,85,0.75)";
const GRID = "rgba(255,255,255,0.05)";
const AXIS_FG = "rgba(180,180,180,0.55)";

const MIN_CANDLE_W = 1.5;
const MAX_CANDLE_W = 80;
const DEFAULT_CANDLE_W = 8;
const MIN_PRICE_PAD = 0.02; // 2% of range
const MAX_PRICE_PAD = 3.0; // 300%
const HOVER_DELAY_MS = 2000;

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

function pickTickIndices(n: number, k: number): number[] {
  if (n <= 0) return [];
  if (n < k) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const t = i / (k - 1);
    out.push(Math.round(t * (n - 1)));
  }
  return Array.from(new Set(out));
}

type DragKind = "pan" | "time-zoom" | "price-zoom";
type DragState = {
  kind: DragKind;
  startX: number;
  startY: number;
  startCandleWidth: number;
  startStartIdx: number;
  startPricePadMult: number;
  moved: boolean;
};

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

  // Time-axis state ----------------------------------------------------
  // `candleWidth` is the absolute pixel slot per candle. Auto-fits all
  // bars on initial mount and whenever a fresh candle series arrives.
  const [candleWidth, setCandleWidth] = useState(DEFAULT_CANDLE_W);
  const [startIdx, setStartIdx] = useState(0);

  // Price-axis state ---------------------------------------------------
  // `pricePadMult` scales the up/down padding around the [hi, lo] range,
  // i.e. y-axis "looseness". 0.05 ~= breathing room, 1.0 ~= 100% padding
  // (more vertical space → candles look smaller).
  const [pricePadMult, setPricePadMult] = useState(0.05);

  // Auto-fit on new data: pick candleWidth so all bars fill the plot.
  useEffect(() => {
    const plotW = Math.max(0, width - PAD_L - PAD_R);
    if (candles.length === 0 || plotW <= 0) return;
    const fit = plotW / candles.length;
    setCandleWidth(Math.max(MIN_CANDLE_W, Math.min(MAX_CANDLE_W, fit)));
    setStartIdx(0);
    setPricePadMult(0.05);
  }, [candles, width]);

  // Drag + hover -------------------------------------------------------
  const dragRef = useRef<DragState | null>(null);
  const [hoverGlobalIdx, setHoverGlobalIdx] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [deepHover, setDeepHover] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setDeepHover(false);
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (hoverGlobalIdx === null) return;
    hoverTimerRef.current = window.setTimeout(() => {
      setDeepHover(true);
    }, HOVER_DELAY_MS);
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, [hoverGlobalIdx]);

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

  // Layout -------------------------------------------------------------
  const plotW = Math.max(0, width - PAD_L - PAD_R);
  const plotH = Math.max(0, height - PAD_T - PAD_B);
  const visibleCount = Math.max(
    1,
    Math.min(candles.length, Math.floor(plotW / Math.max(MIN_CANDLE_W, candleWidth))),
  );
  const clampedStart = Math.max(
    0,
    Math.min(candles.length - visibleCount, startIdx),
  );
  const endIdx = clampedStart + visibleCount;
  const visible = candles.slice(clampedStart, endIdx);

  const layout = useMemo(() => {
    if (visible.length === 0) return null;
    const bodyW = Math.max(MIN_CANDLE_W * 0.7, candleWidth * 0.65);
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
    const rng = hi - lo;
    const pricePad = rng * pricePadMult;
    const yMax = hi + pricePad;
    const yMin = lo - pricePad;
    const ySpan = yMax - yMin;

    const xOf = (i: number) => PAD_L + candleWidth * (i + 0.5);
    const yOf = (price: number) =>
      PAD_T + ((yMax - price) / ySpan) * plotH;

    return { bodyW, yMax, yMin, ySpan, xOf, yOf };
  }, [visible, candleWidth, pricePadMult, plotH]);

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

  const { yMax, yMin, xOf, yOf, bodyW } = layout;
  const mid = (yMax + yMin) / 2;

  // Geometry helpers ---------------------------------------------------
  function clientPos(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function inTimeAxis(y: number) {
    return y >= height - PAD_B;
  }
  function inPriceAxis(x: number) {
    return x >= width - PAD_R;
  }
  function clientToVisibleIdx(x: number): number {
    const idx = Math.floor((x - PAD_L) / candleWidth);
    return Math.max(0, Math.min(visible.length - 1, idx));
  }

  // Event handlers -----------------------------------------------------
  function onMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    const { x, y } = clientPos(e);
    const kind: DragKind = inTimeAxis(y)
      ? "time-zoom"
      : inPriceAxis(x)
        ? "price-zoom"
        : "pan";
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      startCandleWidth: candleWidth,
      startStartIdx: clampedStart,
      startPricePadMult: pricePadMult,
      moved: false,
    };
  }

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const ds = dragRef.current;
    const { x, y } = clientPos(e);
    setHoverPos({ x, y });

    if (ds) {
      if (
        Math.abs(e.clientX - ds.startX) > 2 ||
        Math.abs(e.clientY - ds.startY) > 2
      ) {
        ds.moved = true;
      }
      if (ds.kind === "pan") {
        const dx = e.clientX - ds.startX;
        const candleDelta = -Math.round(dx / Math.max(MIN_CANDLE_W, candleWidth));
        let ns = ds.startStartIdx + candleDelta;
        ns = Math.max(0, Math.min(candles.length - visibleCount, ns));
        setStartIdx(ns);
      } else if (ds.kind === "time-zoom") {
        // Drag down (positive dy) → candles wider (zoom in time).
        const dy = e.clientY - ds.startY;
        const factor = Math.exp(dy / 120); // smooth exponential feel
        const next = Math.max(
          MIN_CANDLE_W,
          Math.min(MAX_CANDLE_W, ds.startCandleWidth * factor),
        );
        setCandleWidth(next);
      } else if (ds.kind === "price-zoom") {
        // Drag down → more padding → candles look smaller (zoom out vert).
        const dy = e.clientY - ds.startY;
        const factor = Math.exp(dy / 140);
        const next = Math.max(
          MIN_PRICE_PAD,
          Math.min(MAX_PRICE_PAD, ds.startPricePadMult * factor),
        );
        setPricePadMult(next);
      }
      setHoverGlobalIdx(null);
      return;
    }

    if (inTimeAxis(y) || inPriceAxis(x)) {
      setHoverGlobalIdx(null);
    } else {
      const vIdx = clientToVisibleIdx(x);
      setHoverGlobalIdx(clampedStart + vIdx);
    }
  }

  function onMouseUp() {
    dragRef.current = null;
  }
  function onMouseLeave() {
    dragRef.current = null;
    setHoverGlobalIdx(null);
    setHoverPos(null);
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    // Wheel = horizontal pan (matches TradingView's default vertical-wheel
    // behaviour). Shift+wheel and trackpad horizontal swipe also routed here.
    const dx = e.deltaY + e.deltaX;
    const candleDelta = Math.round(dx / Math.max(8, candleWidth));
    if (candleDelta === 0) return;
    e.preventDefault();
    let ns = clampedStart + candleDelta;
    ns = Math.max(0, Math.min(candles.length - visibleCount, ns));
    setStartIdx(ns);
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    const { x, y } = clientPos(e);
    if (inTimeAxis(y)) {
      // Reset time axis only — fit all bars horizontally.
      const fit = plotW / Math.max(1, candles.length);
      setCandleWidth(Math.max(MIN_CANDLE_W, Math.min(MAX_CANDLE_W, fit)));
      setStartIdx(0);
    } else if (inPriceAxis(x)) {
      setPricePadMult(0.05);
    } else {
      // Reset both
      const fit = plotW / Math.max(1, candles.length);
      setCandleWidth(Math.max(MIN_CANDLE_W, Math.min(MAX_CANDLE_W, fit)));
      setStartIdx(0);
      setPricePadMult(0.05);
    }
  }

  // Hover-derived bits -------------------------------------------------
  const hoverVisibleIdx =
    hoverGlobalIdx !== null ? hoverGlobalIdx - clampedStart : null;
  const hovered =
    hoverVisibleIdx !== null && hoverVisibleIdx >= 0 && hoverVisibleIdx < visible.length
      ? visible[hoverVisibleIdx]
      : null;
  const hoverX = hovered && hoverVisibleIdx !== null ? xOf(hoverVisibleIdx) : null;
  const hoverY = hovered && hoverX !== null ? yOf(hovered.c) : null;

  const last = visible[visible.length - 1];
  const lastUp = last.c >= last.o;
  const accent = lastUp ? UP_COLOR : DOWN_COLOR;
  const tickIdxs = pickTickIndices(visible.length, 5);

  // Cursor hint --------------------------------------------------------
  let cursor = "crosshair";
  if (dragRef.current) {
    cursor =
      dragRef.current.kind === "pan"
        ? "grabbing"
        : dragRef.current.kind === "time-zoom"
          ? "ew-resize"
          : "ns-resize";
  }

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
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        style={{
          cursor,
          display: "block",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {/* Axis drag-zone hover affordances — invisible but capture pointer */}
        {/* (drawn first so candles paint over them where they overlap) */}

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
            <g key={`${c.t}-${i}`}>
              <line
                x1={x}
                x2={x}
                y1={yHigh}
                y2={yLow}
                stroke={color}
                strokeWidth={Math.max(0.7, Math.min(2, bodyW * 0.15))}
              />
              <rect
                x={x - bodyW / 2}
                y={bodyY}
                width={bodyW}
                height={bodyH}
                fill={fill}
                stroke={color}
                strokeWidth={0.6}
              />
            </g>
          );
        })}

        {/* Bottom time labels */}
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
              y={height - 7}
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

      {/* OHLC strip — always shown on hover, top-left of chart */}
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

      {/* Deep hover pill — appears after 2s of resting on the same candle,
          right next to the cursor. Bigger, time-only, clear callout. */}
      {hovered && deepHover && hoverPos ? (
        <motion.div
          initial={{ opacity: 0, y: -4, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.18, ease: [0.22, 0.9, 0.36, 1] }}
          style={{
            position: "absolute",
            left: Math.min(width - 180, Math.max(0, hoverPos.x + 14)),
            top: Math.max(0, hoverPos.y - 38),
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11,
            letterSpacing: "0.05em",
            color: "var(--fg-0)",
            background: "rgba(20,20,20,0.92)",
            border: `1px solid ${accent.replace("0.95", "0.35")}`,
            borderRadius: 4,
            padding: "5px 10px",
            boxShadow: `0 0 16px ${accent.replace("0.95", "0.18")}`,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {fmtCandleTime(hovered.t, timeframe, true)}
        </motion.div>
      ) : null}

      {/* Hint — fades on first drag interaction would be nice, kept static */}
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
        DRAG · AXIS↕ · 2×CLICK
      </div>
    </div>
  );
}
