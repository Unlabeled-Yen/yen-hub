"use client";

/**
 * CandleChart — TradingView-style candlestick chart, Yen Hub flavored.
 *
 * Interaction model:
 *   - Wheel ↑↓ → vertical (price-axis) zoom, anchored on the latest close.
 *     Most recent price stays under the cursor's y position throughout.
 *   - Drag → free 4-direction pan (left/right shifts time; up/down shifts
 *     vertical center of viewport).
 *   - Double-click → reset zoom & pan, fit all bars.
 *   - Hover ≥ 2s on a candle → "deep hover" pill near cursor with the
 *     bar's full timestamp.
 *
 * Coordinate system (pure state, no fitting to bbox):
 *   xStart       : decimal index of the candle at the chart's LEFT edge
 *   candleWidth  : px per candle (fixed within a tf; reset on tf swap)
 *   yCenter      : price at the vertical center of the plot
 *   yScale       : px per $1 of price
 *   xOf(i)       = PAD_L + (i - xStart) * candleWidth + candleWidth/2
 *   yOf(p)       = PAD_T + plotH/2 + (yCenter - p) * yScale
 *
 * Time encoding: API stamps NY clock time as UTC ms; all `toLocaleString`
 * here pin timeZone:"UTC" so labels show the raw NY time.
 */

import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Candle = { t: number; o: number; h: number; l: number; c: number };

const PAD_L = 8;
const PAD_R = 56;
const PAD_T = 8;
const PAD_B = 22;

// Up = warm orange (Yen Hub brand-adjacent). Down = pale cream-mustard
// (desaturated toward white). The pair reads as "fire vs sand" against
// near-black — distinct without invoking red/green loss baggage.
const UP_COLOR = "rgba(255,170,100,0.95)";
const UP_FILL = "rgba(255,170,100,0.75)";
const DOWN_COLOR = "rgba(235,225,185,0.95)";
const DOWN_FILL = "rgba(235,225,185,0.75)";
const GRID = "rgba(255,255,255,0.05)";
const AXIS_FG = "rgba(180,180,180,0.55)";

const MIN_YSCALE_FACTOR = 0.2; // can zoom OUT to 20% of auto-fit
const MAX_YSCALE_FACTOR = 50; // can zoom IN 50× the auto-fit
const WHEEL_ZOOM_STEP = 1.12; // each wheel notch
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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

  // Viewport state — see header comment for math.
  const [xStart, setXStart] = useState(0);
  const [candleWidth, setCandleWidth] = useState(8);
  const [yCenter, setYCenter] = useState(0);
  const [yScale, setYScale] = useState(1);

  // Baseline yScale from auto-fit — used for clamp limits + reset.
  const baseYScaleRef = useRef(1);

  // Refs mirror state for window-attached event handlers to avoid stale
  // closures.
  const xStartRef = useRef(xStart);
  const candleWidthRef = useRef(candleWidth);
  const yCenterRef = useRef(yCenter);
  const yScaleRef = useRef(yScale);
  useEffect(() => {
    xStartRef.current = xStart;
  }, [xStart]);
  useEffect(() => {
    candleWidthRef.current = candleWidth;
  }, [candleWidth]);
  useEffect(() => {
    yCenterRef.current = yCenter;
  }, [yCenter]);
  useEffect(() => {
    yScaleRef.current = yScale;
  }, [yScale]);

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

  const plotW = Math.max(0, width - PAD_L - PAD_R);
  const plotH = Math.max(0, height - PAD_T - PAD_B);
  const midY = PAD_T + plotH / 2;

  // Auto-fit on new data (tf swap or fresh mount).
  useEffect(() => {
    if (candles.length === 0 || plotW <= 0 || plotH <= 0) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) {
      hi = (Number.isFinite(hi) ? hi : 0) + 1;
      lo = (Number.isFinite(lo) ? lo : 0) - 1;
    }
    const pad = (hi - lo) * 0.05;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const fitYScale = plotH / (yMax - yMin);
    baseYScaleRef.current = fitYScale;
    setYCenter((yMin + yMax) / 2);
    setYScale(fitYScale);
    setCandleWidth(plotW / candles.length);
    setXStart(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, plotW, plotH]);

  // Helpers ------------------------------------------------------------
  const xOf = useCallback(
    (globalIdx: number) =>
      PAD_L + (globalIdx - xStart) * candleWidth + candleWidth / 2,
    [xStart, candleWidth],
  );
  const yOf = useCallback(
    (price: number) => midY + (yCenter - price) * yScale,
    [midY, yCenter, yScale],
  );

  // Hover --------------------------------------------------------------
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

  // Drag (window-attached so the gesture survives leaving the panel).
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startXStart: number;
    startYCenter: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const applyDrag = useCallback(
    (e: MouseEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      const dx = e.clientX - ds.startClientX;
      const dy = e.clientY - ds.startClientY;
      // drag right → see earlier candles (xStart decreases)
      const newXStart =
        ds.startXStart - dx / Math.max(0.5, candleWidthRef.current);
      // drag down → shift price viewport up (look at higher prices)
      const newYCenter =
        ds.startYCenter + dy / Math.max(0.0001, yScaleRef.current);
      setXStart(newXStart);
      setYCenter(newYCenter);
    },
    [],
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

  function onMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startXStart: xStart,
      startYCenter: yCenter,
    };
    setDragging(true);
    setHoverGlobalIdx(null);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
  }

  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (dragRef.current) return; // window listener owns it
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setHoverPos({ x, y });
    if (y < PAD_T || y > height - PAD_B || x < PAD_L || x > width - PAD_R) {
      setHoverGlobalIdx(null);
      return;
    }
    const globalIdx = Math.floor(
      (x - PAD_L) / Math.max(0.5, candleWidth) + xStart,
    );
    if (globalIdx >= 0 && globalIdx < candles.length) {
      setHoverGlobalIdx(globalIdx);
    } else {
      setHoverGlobalIdx(null);
    }
  }

  function onMouseLeave() {
    setHoverGlobalIdx(null);
    setHoverPos(null);
  }

  // Wheel = vertical zoom anchored on latest close ---------------------
  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (candles.length === 0) return;
    if (Math.abs(e.deltaY) < 1) return;
    e.preventDefault();
    const latest = candles[candles.length - 1].c;
    const oldYScale = yScaleRef.current;
    const oldYCenter = yCenterRef.current;
    // Where is the anchor price on screen right now?
    const oldAnchorY = midY + (oldYCenter - latest) * oldYScale;
    const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
    const base = baseYScaleRef.current || 1;
    const newYScale = clamp(
      oldYScale * factor,
      base * MIN_YSCALE_FACTOR,
      base * MAX_YSCALE_FACTOR,
    );
    if (newYScale === oldYScale) return;
    // Solve newYCenter so anchor stays at oldAnchorY:
    //   midY + (newYCenter - latest) * newYScale = oldAnchorY
    const newYCenter = (oldAnchorY - midY) / newYScale + latest;
    setYScale(newYScale);
    setYCenter(newYCenter);
  }

  function onDoubleClick() {
    if (candles.length === 0 || plotW <= 0 || plotH <= 0) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    const pad = (hi - lo) * 0.05;
    const yMin = lo - pad;
    const yMax = hi + pad;
    const fit = plotH / (yMax - yMin);
    baseYScaleRef.current = fit;
    setYCenter((yMin + yMax) / 2);
    setYScale(fit);
    setCandleWidth(plotW / candles.length);
    setXStart(0);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
    };
  }, [onWindowMove, onWindowUp]);

  // Hover-derived ------------------------------------------------------
  const hovered =
    hoverGlobalIdx !== null && hoverGlobalIdx < candles.length
      ? candles[hoverGlobalIdx]
      : null;
  const hoverX = hoverGlobalIdx !== null ? xOf(hoverGlobalIdx) : null;
  const hoverY = hovered && hoverX !== null ? yOf(hovered.c) : null;

  // Grid labels — three price levels from current viewport
  const viewYTop = yCenter + plotH / 2 / Math.max(0.0001, yScale);
  const viewYBottom = yCenter - plotH / 2 / Math.max(0.0001, yScale);
  const gridPrices = [viewYTop, yCenter, viewYBottom];

  const accent =
    candles.length > 0 &&
    candles[candles.length - 1].c >= candles[candles.length - 1].o
      ? UP_COLOR
      : DOWN_COLOR;

  // Entry-animation key: changes only on structural series swap.
  const seriesKey = `${timeframe}-${candles.length}-${candles[0]?.t ?? 0}`;

  // Body geometry helper — uniform body width across all candles
  const bodyW = Math.max(1.5, candleWidth * 0.65);

  // X-axis time tick indices: pick 5 evenly across candles that land in
  // the visible plot horizontally.
  const visibleTickIdxs = useMemo(() => {
    if (candles.length === 0) return [];
    const out: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const x = xOf(i);
      if (x >= PAD_L - candleWidth && x <= width - PAD_R + candleWidth) {
        out.push(i);
      }
    }
    if (out.length === 0) return [];
    if (out.length <= 5) return out;
    const picks: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t = k / 4;
      picks.push(out[Math.round(t * (out.length - 1))]);
    }
    return Array.from(new Set(picks));
  }, [candles.length, xOf, candleWidth, width]);

  const spansMultipleDays = useMemo(() => {
    if (visibleTickIdxs.length < 2) return false;
    const first = new Date(candles[visibleTickIdxs[0]].t)
      .toISOString()
      .slice(0, 10);
    const last = new Date(candles[visibleTickIdxs[visibleTickIdxs.length - 1]].t)
      .toISOString()
      .slice(0, 10);
    return first !== last;
  }, [visibleTickIdxs, candles]);

  if (candles.length === 0) {
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

  return (
    <div
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      style={{
        position: "relative",
        width: "100%",
        height,
        cursor: dragging ? "grabbing" : "crosshair",
        userSelect: "none",
        touchAction: "none",
      }}
    >
      {/* Static SVG layer — grid + axis labels + hover crosshair */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{
          display: "block",
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      >
        {gridPrices.map((p, i) => (
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
        {gridPrices.map((p, i) => (
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

        {visibleTickIdxs.map((idx, i) => {
          const c = candles[idx];
          if (!c) return null;
          const x = xOf(idx);
          if (x < PAD_L - 4 || x > width - PAD_R + 4) return null;
          const isFirst = i === 0;
          const isLast = i === visibleTickIdxs.length - 1;
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

      {/* Candle layer — HTML divs with reveal-from-bottom entry animation.
          overflow:hidden clips anything beyond the plot region so panning
          off the edges doesn't bleed into the chart card. */}
      <div
        style={{
          position: "absolute",
          left: PAD_L,
          top: PAD_T,
          width: plotW,
          height: plotH,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? UP_COLOR : DOWN_COLOR;
          const fill = up ? UP_FILL : DOWN_FILL;
          const x = xOf(i) - PAD_L; // relative to clip container
          const yHigh = yOf(c.h) - PAD_T;
          const yLow = yOf(c.l) - PAD_T;
          const yOpen = yOf(c.o) - PAD_T;
          const yClose = yOf(c.c) - PAD_T;
          const bodyY = Math.min(yOpen, yClose);
          const bodyH = Math.max(1, Math.abs(yOpen - yClose));
          const wickW = Math.max(1, Math.min(2, bodyW * 0.18));
          const candleH = Math.max(1, yLow - yHigh);

          // Cull off-screen for cheap render (purely optimization).
          if (x < -candleWidth || x > plotW + candleWidth) return null;

          const STAGGER_TOTAL = 1.6;
          const stagger =
            candles.length > 1
              ? (i / (candles.length - 1)) * STAGGER_TOTAL
              : 0;

          return (
            <div
              key={`${seriesKey}-${c.t}-${i}`}
              style={{
                position: "absolute",
                left: x - bodyW / 2,
                top: yHigh,
                width: bodyW,
                height: candleH,
                pointerEvents: "none",
              }}
            >
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: candleH }}
                transition={{
                  duration: 0.45,
                  delay: stagger,
                  ease: [0.22, 0.9, 0.36, 1],
                }}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: candleH,
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: 0,
                      bottom: 0,
                      width: wickW,
                      marginLeft: -wickW / 2,
                      background: color,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: bodyY - yHigh,
                      height: bodyH,
                      background: fill,
                      border: `0.6px solid ${color}`,
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              </motion.div>
            </div>
          );
        })}
      </div>

      {/* Hover OHLC strip (top-left) */}
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

      {/* Deep hover pill (2s) */}
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
        WHEEL: HEIGHT ZOOM · DRAG: 4-WAY PAN · 2×CLICK RESET
      </div>
    </div>
  );
}
