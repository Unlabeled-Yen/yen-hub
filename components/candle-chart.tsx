"use client";

/**
 * CandleChart — TradingView-style candlestick chart.
 *
 * Layout: each candle takes a fixed pixel slot (`candleWidth`). Body/wick
 * scale uniformly with slot, so adjacency visually never changes.
 *
 * Single fluid gesture on the chart body:
 *   - Horizontal drag → pan time (left/right)
 *   - Vertical drag   → zoom *anchored on the candle you clicked*
 *                       (drag DOWN = K wider, in; drag UP = K narrower, out)
 *   - Diagonal       → both at once, smoothly
 *   While dragging, the cursor can leave the chart panel — window-level
 *   listeners track it.
 *
 * Other:
 *   - Wheel anywhere → horizontal pan
 *   - Double-click → reset (fit all bars)
 *   - Hover ≥ 2s on a candle → "deep hover" pill near cursor with
 *     the bar's full timestamp
 *   - Always-on OHLC strip top-left while hovering
 *
 * Time encoding: API stamps NY clock time as UTC ms; all `toLocaleString`
 * here pin timeZone:"UTC" to display the literal NY time.
 */

import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Candle = { t: number; o: number; h: number; l: number; c: number };

const PAD_L = 8;
const PAD_R = 56;
const PAD_T = 8;
const PAD_B = 22;

const UP_COLOR = "rgba(255,184,120,0.95)";
const UP_FILL = "rgba(255,184,120,0.75)";
const DOWN_COLOR = "rgba(255,95,85,0.95)";
const DOWN_FILL = "rgba(255,95,85,0.75)";
const GRID = "rgba(255,255,255,0.05)";
const AXIS_FG = "rgba(180,180,180,0.55)";

const MIN_CANDLE_W = 1.5;
const MAX_CANDLE_W = 80;
const HOVER_DELAY_MS = 2000;
const ZOOM_PIXELS_PER_E = 220; // softer = drag further to zoom 1 e-fold

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

type DragState = {
  startClientX: number;
  startClientY: number;
  startCandleWidth: number;
  // The global candle index under the cursor at mousedown — we keep this
  // candle's screen x fixed throughout the drag.
  anchorGlobalIdx: number;
  // The screen-x (relative to plot area, i.e. minus PAD_L) of that anchor
  // at mousedown.
  anchorPlotX: number;
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
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(600);

  const [candleWidth, setCandleWidth] = useState(8);
  const [startIdx, setStartIdx] = useState(0);

  // Refs mirror state for use inside event listeners attached to window —
  // those closures would otherwise capture stale state.
  const candleWidthRef = useRef(candleWidth);
  const startIdxRef = useRef(startIdx);
  useEffect(() => {
    candleWidthRef.current = candleWidth;
  }, [candleWidth]);
  useEffect(() => {
    startIdxRef.current = startIdx;
  }, [startIdx]);

  // Auto-fit on new data.
  useEffect(() => {
    const plotW = Math.max(0, width - PAD_L - PAD_R);
    if (candles.length === 0 || plotW <= 0) return;
    const fit = plotW / candles.length;
    setCandleWidth(Math.max(MIN_CANDLE_W, Math.min(MAX_CANDLE_W, fit)));
    setStartIdx(0);
  }, [candles, width]);

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
    Math.min(Math.max(0, candles.length - visibleCount), startIdx),
  );
  const visible = candles.slice(clampedStart, clampedStart + visibleCount);

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
    const pricePad = rng * 0.05;
    const yMax = hi + pricePad;
    const yMin = lo - pricePad;
    const ySpan = yMax - yMin;
    const xOf = (i: number) => PAD_L + candleWidth * (i + 0.5);
    const yOf = (price: number) =>
      PAD_T + ((yMax - price) / ySpan) * plotH;
    return { bodyW, yMax, yMin, ySpan, xOf, yOf };
  }, [visible, candleWidth, plotH]);

  const spansMultipleDays = useMemo(() => {
    if (visible.length < 2) return false;
    const first = new Date(visible[0].t).toISOString().slice(0, 10);
    const last = new Date(visible[visible.length - 1].t)
      .toISOString()
      .slice(0, 10);
    return first !== last;
  }, [visible]);

  // Hover state --------------------------------------------------------
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
    hoverTimerRef.current = window.setTimeout(
      () => setDeepHover(true),
      HOVER_DELAY_MS,
    );
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, [hoverGlobalIdx]);

  // Drag handling via window listeners --------------------------------
  // Attached on mousedown, detached on mouseup. This decouples drag from
  // the chart's hover area — the cursor can leave the panel entirely and
  // the drag keeps tracking.
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  const applyDrag = useCallback(
    (e: MouseEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const dx = e.clientX - ds.startClientX;
      const dy = e.clientY - ds.startClientY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) ds.moved = true;

      // Vertical → zoom (anchor stays put). Drag DOWN → K wider.
      const newCandleWidth = Math.max(
        MIN_CANDLE_W,
        Math.min(
          MAX_CANDLE_W,
          ds.startCandleWidth * Math.exp(dy / ZOOM_PIXELS_PER_E),
        ),
      );

      // Horizontal → pan, measured in candle slots at the *new* width.
      const panCandles = -dx / Math.max(MIN_CANDLE_W, newCandleWidth);

      // Compute startIdx so anchorGlobalIdx maps to ds.anchorPlotX.
      //   anchorVisIdx_after = ds.anchorPlotX / newCandleWidth - 0.5
      //   startIdx_after = anchorGlobalIdx - anchorVisIdx_after + panCandles
      const anchorVisIdxAfter = ds.anchorPlotX / newCandleWidth - 0.5;
      let ns = Math.round(
        ds.anchorGlobalIdx - anchorVisIdxAfter + panCandles,
      );
      // Clamp to valid window.
      const vc = Math.max(
        1,
        Math.min(
          candles.length,
          Math.floor(plotW / Math.max(MIN_CANDLE_W, newCandleWidth)),
        ),
      );
      ns = Math.max(0, Math.min(Math.max(0, candles.length - vc), ns));

      setCandleWidth(newCandleWidth);
      setStartIdx(ns);
    },
    [candles.length, plotW],
  );

  const onWindowMove = useCallback(
    (e: MouseEvent) => {
      applyDrag(e);
    },
    [applyDrag],
  );

  const onWindowUp = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
    window.removeEventListener("mousemove", onWindowMove);
    window.removeEventListener("mouseup", onWindowUp);
  }, [onWindowMove]);

  function onMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotX = x - PAD_L;
    const visIdx = Math.max(
      0,
      Math.min(visible.length - 1, Math.floor(plotX / Math.max(1, candleWidth))),
    );
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCandleWidth: candleWidth,
      anchorGlobalIdx: clampedStart + visIdx,
      anchorPlotX: plotX,
      moved: false,
    };
    setDragging(true);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
  }

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (dragRef.current) return; // window listener owns it
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setHoverPos({ x, y });
    if (y < PAD_T || y > height - PAD_B || x < PAD_L || x > width - PAD_R) {
      setHoverGlobalIdx(null);
      return;
    }
    const idx = Math.floor((x - PAD_L) / Math.max(1, candleWidth));
    if (idx >= 0 && idx < visible.length) {
      setHoverGlobalIdx(clampedStart + idx);
    } else {
      setHoverGlobalIdx(null);
    }
  }

  function onMouseLeave() {
    setHoverGlobalIdx(null);
    setHoverPos(null);
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    const dx = e.deltaY + e.deltaX;
    if (Math.abs(dx) < 1) return;
    e.preventDefault();
    const cur = candleWidthRef.current;
    const candleDelta = Math.round(dx / Math.max(8, cur));
    if (candleDelta === 0) return;
    const vc = Math.max(
      1,
      Math.min(
        candles.length,
        Math.floor(plotW / Math.max(MIN_CANDLE_W, cur)),
      ),
    );
    let ns = startIdxRef.current + candleDelta;
    ns = Math.max(0, Math.min(Math.max(0, candles.length - vc), ns));
    setStartIdx(ns);
  }

  function onDoubleClick() {
    const fit = plotW / Math.max(1, candles.length);
    setCandleWidth(Math.max(MIN_CANDLE_W, Math.min(MAX_CANDLE_W, fit)));
    setStartIdx(0);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
    };
  }, [onWindowMove, onWindowUp]);

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

  const hoverVisibleIdx =
    hoverGlobalIdx !== null ? hoverGlobalIdx - clampedStart : null;
  const hovered =
    hoverVisibleIdx !== null &&
    hoverVisibleIdx >= 0 &&
    hoverVisibleIdx < visible.length
      ? visible[hoverVisibleIdx]
      : null;
  const hoverX =
    hovered && hoverVisibleIdx !== null ? xOf(hoverVisibleIdx) : null;
  const hoverY = hovered && hoverX !== null ? yOf(hovered.c) : null;

  const last = visible[visible.length - 1];
  const lastUp = last.c >= last.o;
  const accent = lastUp ? UP_COLOR : DOWN_COLOR;
  const tickIdxs = pickTickIndices(visible.length, 5);

  // Entry-animation key: changes only when the underlying series is
  // structurally new (different tf or different start). Live 60s polling
  // keeps the same length + first-timestamp, so this stays stable and the
  // candles don't re-animate on every refetch.
  const seriesKey = `${timeframe}-${candles.length}-${candles[0]?.t ?? 0}`;

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
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        style={{
          cursor: dragging ? "grabbing" : "crosshair",
          display: "block",
          touchAction: "none",
          userSelect: "none",
        }}
      >
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

        {/* Candles — sequential "draw from bottom + lift + settle" animation.
            Outer group handles vertical lift; inner group handles the
            scaleY-from-bottom that produces the actual draw effect.
            seriesKey re-mounts on tf swap → animation replays. */}
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
          const wickW = Math.max(0.7, Math.min(2, bodyW * 0.15));

          // Stagger total stays modest so the whole reveal completes
          // before 60s polling could re-fetch; longer than 2.5s feels slow.
          const STAGGER_TOTAL = 1.6;
          const stagger =
            visible.length > 1
              ? (i / (visible.length - 1)) * STAGGER_TOTAL
              : 0;
          const DUR = 0.8;

          return (
            <motion.g
              key={`${seriesKey}-${c.t}-${i}`}
              initial={{ y: 0 }}
              animate={{ y: [0, -10, -10, 0] }}
              transition={{
                duration: DUR,
                delay: stagger,
                times: [0, 0.4, 0.6, 1],
                ease: [0.22, 0.9, 0.36, 1],
              }}
            >
              {/* Halo — opacity-only, lives with the outer lift group */}
              <motion.rect
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.55, 0.55, 0] }}
                transition={{
                  duration: DUR,
                  delay: stagger,
                  times: [0, 0.4, 0.6, 1],
                  ease: "easeOut",
                }}
                x={x - bodyW}
                y={yHigh - 4}
                width={bodyW * 2}
                height={yLow - yHigh + 8}
                fill={color}
                style={{
                  filter: `blur(6px)`,
                  pointerEvents: "none",
                }}
              />
              {/* Inner group: scaleY 0→1 with transform-origin at the
                  candle's LOW edge — wick + body grow upward from yLow.
                  transformBox:fill-box makes the % origin map to the
                  inner group's bounding box (bottom-center = low/middle). */}
              <motion.g
                initial={{ scaleY: 0, opacity: 0 }}
                animate={{
                  scaleY: [0, 1, 1, 1],
                  opacity: [0, 1, 1, 1],
                }}
                transition={{
                  duration: DUR,
                  delay: stagger,
                  times: [0, 0.4, 0.6, 1],
                  ease: [0.22, 0.9, 0.36, 1],
                }}
                style={{
                  transformOrigin: "50% 100%",
                  transformBox: "fill-box" as "fill-box",
                }}
              >
                {/* Wick */}
                <line
                  x1={x}
                  x2={x}
                  y1={yHigh}
                  y2={yLow}
                  stroke={color}
                  strokeWidth={wickW}
                  vectorEffect="non-scaling-stroke"
                />
                {/* Body */}
                <rect
                  x={x - bodyW / 2}
                  y={bodyY}
                  width={bodyW}
                  height={bodyH}
                  fill={fill}
                  stroke={color}
                  strokeWidth={0.6}
                  vectorEffect="non-scaling-stroke"
                />
              </motion.g>
            </motion.g>
          );
        })}

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

        {hovered && hoverX !== null && hoverY !== null && !dragging ? (
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

      {hovered && !dragging ? (
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

      {hovered && deepHover && hoverPos && !dragging ? (
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
        DRAG: ←→ PAN · ↑↓ ZOOM · 2×CLICK RESET
      </div>
    </div>
  );
}
