"use client";

/**
 * CandleChart — Yen Hub OHLC candlestick chart.
 *
 * Interaction model (per Yen's spec):
 *   - Drag on the right price-axis strip ↑↓ → vertical zoom. Anchor =
 *     mean close of the latest 5 candles, kept at its current screen y.
 *   - Mouse wheel ↑ widens K-to-K spacing (zoom IN on time); ↓ narrows,
 *     clamped to the baseline default. Anchor = horizontal centroid of
 *     the latest 5 candles. Wheel handler is attached via DOM API with
 *     `passive: false` so preventDefault actually stops page scroll.
 *   - Drag on the main canvas → horizontal pan only.
 *   - Double-click → reset to auto-fit.
 *   - Hover ≥ 2s on a candle → "deep hover" pill with full timestamp.
 *
 * Reveal animation:
 *   First time the chart sees candles (login → home transition) → slow,
 *   staggered draw-from-bottom with glow halo. Subsequent series swaps
 *   (timeframe switch) → fast opacity fade. After the reveal window
 *   closes the candles render as plain static divs (no motion overhead),
 *   so zoom/pan stays smooth.
 *
 * Time encoding: API stamps NY clock time as UTC ms; all `toLocaleString`
 * here pin timeZone:"UTC" so labels show the raw NY time.
 */

import { motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type Candle = { t: number; o: number; h: number; l: number; c: number };

const PAD_L = 8;
const PAD_R = 56;
const PAD_T = 8;
const PAD_B = 22;

const UP_COLOR = "rgba(255,170,100,0.95)";
const UP_FILL = "rgba(255,170,100,0.75)";
const DOWN_COLOR = "rgba(235,225,185,0.95)";
const DOWN_FILL = "rgba(235,225,185,0.75)";
const GRID = "rgba(255,255,255,0.05)";
const AXIS_FG = "rgba(180,180,180,0.55)";

const ANCHOR_TAIL = 5;
const WHEEL_STEP = 1.12;
const MAX_CANDLE_W = 80;
const MIN_YSCALE_FACTOR = 0.2;
const MAX_YSCALE_FACTOR = 50;
const HOVER_DELAY_MS = 2000;

const INITIAL_DUR = 0.85;
const INITIAL_STAGGER_TOTAL = 2.6;
const FAST_DUR = 0.22;

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

function latestAnchors(candles: Candle[], n = ANCHOR_TAIL) {
  const N = Math.min(n, candles.length);
  if (N === 0) return { idx: 0, price: 0 };
  const startI = candles.length - N;
  const endI = candles.length - 1;
  let sum = 0;
  for (let i = startI; i <= endI; i++) sum += candles[i].c;
  return { idx: (startI + endI) / 2, price: sum / N };
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

  const [xStart, setXStart] = useState(0);
  const [candleWidth, setCandleWidth] = useState(8);
  const [yCenter, setYCenter] = useState(0);
  const [yScale, setYScale] = useState(1);

  const baseCandleWidthRef = useRef(8);
  const baseYScaleRef = useRef(1);

  const xStartRef = useRef(xStart);
  const candleWidthRef = useRef(candleWidth);
  const yCenterRef = useRef(yCenter);
  const yScaleRef = useRef(yScale);
  const candlesRef = useRef(candles);
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
    candlesRef.current = candles;
  }, [candles]);

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

  // Auto-fit on new candles (tf swap or fresh mount).
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
    const fitCandleW = plotW / candles.length;
    baseYScaleRef.current = fitYScale;
    baseCandleWidthRef.current = fitCandleW;
    setYCenter((yMin + yMax) / 2);
    setYScale(fitYScale);
    setCandleWidth(fitCandleW);
    setXStart(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, plotW, plotH]);

  const xOf = useCallback(
    (i: number) => PAD_L + (i - xStart + 0.5) * candleWidth,
    [xStart, candleWidth],
  );
  const yOf = useCallback(
    (p: number) => midY + (yCenter - p) * yScale,
    [midY, yCenter, yScale],
  );

  // Reveal cycle ------------------------------------------------------
  // firstShownRef stays true after the very first time candles arrive.
  // isInitialReveal = the slow / glow / staggered draw (login → home).
  // Subsequent reveals (tf swap) are just a fast opacity fade.
  //
  // Layout-phase: useLayoutEffect runs synchronously after commit, before
  // the browser paints. The state updates here flush in the same paint
  // window, so the browser never sees the brief plain-div render that
  // sits between "candles arrived" and "reveal turned on" — no flicker.
  //
  // Strict-mode safe: lastSeriesKeyRef guards against double-invocation
  // mutating firstShownRef out from under us.
  const firstShownRef = useRef(false);
  const lastSeriesKeyRef = useRef<string | null>(null);
  const [revealActive, setRevealActive] = useState(false);
  const [isInitialReveal, setIsInitialReveal] = useState(true);
  const seriesKey = `${timeframe}-${candles.length}-${candles[0]?.t ?? 0}`;
  useLayoutEffect(() => {
    if (candles.length === 0) return;
    if (lastSeriesKeyRef.current === seriesKey) return;
    lastSeriesKeyRef.current = seriesKey;
    const wasInitial = !firstShownRef.current;
    firstShownRef.current = true;
    setIsInitialReveal(wasInitial);
    setRevealActive(true);
  }, [seriesKey, candles.length]);
  // End-of-reveal scheduler — a normal effect is fine here, paint timing
  // doesn't matter for switching back to plain divs.
  useEffect(() => {
    if (!revealActive) return;
    const totalMs = isInitialReveal
      ? (INITIAL_STAGGER_TOTAL + INITIAL_DUR) * 1000 + 200
      : FAST_DUR * 1000 + 80;
    const t = window.setTimeout(() => setRevealActive(false), totalMs);
    return () => window.clearTimeout(t);
  }, [revealActive, isInitialReveal, seriesKey]);

  // Hover -------------------------------------------------------------
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

  // Drag --------------------------------------------------------------
  type DragKind = "pan" | "price-zoom";
  const dragRef = useRef<{
    kind: DragKind;
    startClientX: number;
    startClientY: number;
    startXStart: number;
    startYScale: number;
    startYCenter: number;
  } | null>(null);
  const [dragging, setDragging] = useState<null | DragKind>(null);
  const rafRef = useRef<number | null>(null);
  const lastDragEventRef = useRef<MouseEvent | null>(null);

  const performDrag = useCallback(() => {
    rafRef.current = null;
    const e = lastDragEventRef.current;
    const ds = dragRef.current;
    if (!e || !ds) return;
    if (ds.kind === "pan") {
      // 2D pan — both horizontal and vertical follow the cursor.
      // dx → shift in candles (drag right reveals earlier candles).
      // dy → shift in price (drag down reveals higher prices, since
      // dragging the viewport down moves the visible price window up).
      const dx = e.clientX - ds.startClientX;
      const dy = e.clientY - ds.startClientY;
      const newXStart =
        ds.startXStart - dx / Math.max(0.5, candleWidthRef.current);
      const newYCenter =
        ds.startYCenter + dy / Math.max(0.0001, yScaleRef.current);
      setXStart(newXStart);
      setYCenter(newYCenter);
    } else if (ds.kind === "price-zoom") {
      const dy = e.clientY - ds.startClientY;
      const factor = Math.exp(-dy / 180);
      const base = baseYScaleRef.current || 1;
      const newYScale = clamp(
        ds.startYScale * factor,
        base * MIN_YSCALE_FACTOR,
        base * MAX_YSCALE_FACTOR,
      );
      const { price: anchorPrice } = latestAnchors(candlesRef.current);
      const startAnchorY =
        midY + (ds.startYCenter - anchorPrice) * ds.startYScale;
      const newYCenter = (startAnchorY - midY) / newYScale + anchorPrice;
      setYScale(newYScale);
      setYCenter(newYCenter);
    }
  }, [midY]);

  const onWindowMove = useCallback(
    (e: MouseEvent) => {
      lastDragEventRef.current = e;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(performDrag);
      }
    },
    [performDrag],
  );
  const onWindowUp = useCallback(() => {
    dragRef.current = null;
    setDragging(null);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    window.removeEventListener("mousemove", onWindowMove);
    window.removeEventListener("mouseup", onWindowUp);
  }, [onWindowMove]);

  function inPriceAxis(localX: number) {
    return localX >= width - PAD_R;
  }

  function onMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const kind: DragKind = inPriceAxis(x) ? "price-zoom" : "pan";
    dragRef.current = {
      kind,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startXStart: xStart,
      startYScale: yScale,
      startYCenter: yCenter,
    };
    setDragging(kind);
    setHoverGlobalIdx(null);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
  }

  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (dragRef.current) return;
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

  // Wheel — attach via DOM API so `passive: false` actually takes effect
  // and preventDefault stops page scroll. React's onWheel is passive in
  // modern React, which is why the previous version leaked. The handler
  // uses refs so it stays stable.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const cs = candlesRef.current;
      if (cs.length === 0) return;
      if (Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      const oldCW = candleWidthRef.current;
      const oldXStart = xStartRef.current;
      const base = baseCandleWidthRef.current;
      const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      const newCW = clamp(oldCW * factor, base, MAX_CANDLE_W);
      if (newCW === oldCW) return;
      const { idx: anchorIdx } = latestAnchors(cs);
      const anchorX = PAD_L + (anchorIdx - oldXStart + 0.5) * oldCW;
      const newXStart = anchorIdx + 0.5 - (anchorX - PAD_L) / newCW;
      setCandleWidth(newCW);
      setXStart(newXStart);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

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
    const fitYScale = plotH / (yMax - yMin);
    const fitCandleW = plotW / candles.length;
    baseYScaleRef.current = fitYScale;
    baseCandleWidthRef.current = fitCandleW;
    setYCenter((yMin + yMax) / 2);
    setYScale(fitYScale);
    setCandleWidth(fitCandleW);
    setXStart(0);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [onWindowMove, onWindowUp]);

  // Hover-derived ------------------------------------------------------
  const hovered =
    hoverGlobalIdx !== null && hoverGlobalIdx < candles.length
      ? candles[hoverGlobalIdx]
      : null;
  const hoverX = hoverGlobalIdx !== null ? xOf(hoverGlobalIdx) : null;
  const hoverY = hovered && hoverX !== null ? yOf(hovered.c) : null;

  const viewYTop = yCenter + plotH / 2 / Math.max(0.0001, yScale);
  const viewYBottom = yCenter - plotH / 2 / Math.max(0.0001, yScale);
  const gridPrices = [viewYTop, yCenter, viewYBottom];

  const accent =
    candles.length > 0 &&
    candles[candles.length - 1].c >= candles[candles.length - 1].o
      ? UP_COLOR
      : DOWN_COLOR;

  const bodyW = Math.max(1.5, candleWidth * 0.65);

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

  let cursor: string = "crosshair";
  if (dragging === "pan") cursor = "grabbing";
  else if (dragging === "price-zoom") cursor = "ns-resize";
  else if (hoverPos && inPriceAxis(hoverPos.x)) cursor = "ns-resize";

  return (
    <div
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onDoubleClick={onDoubleClick}
      style={{
        position: "relative",
        width: "100%",
        height,
        cursor,
        userSelect: "none",
        touchAction: "none",
      }}
    >
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

      {/* Candle layer — clip via overflow:hidden so panning past the plot
          edges doesn't bleed across the card. */}
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
          const x = xOf(i) - PAD_L;
          const yHigh = yOf(c.h) - PAD_T;
          const yLow = yOf(c.l) - PAD_T;
          const yOpen = yOf(c.o) - PAD_T;
          const yClose = yOf(c.c) - PAD_T;
          const bodyY = Math.min(yOpen, yClose);
          const bodyH = Math.max(1, Math.abs(yOpen - yClose));
          const wickW = Math.max(1, Math.min(2, bodyW * 0.18));
          const candleH = Math.max(1, yLow - yHigh);

          if (x < -candleWidth || x > plotW + candleWidth) return null;

          const posStyle: React.CSSProperties = {
            position: "absolute",
            left: x - bodyW / 2,
            top: yHigh,
            width: bodyW,
            height: candleH,
            pointerEvents: "none",
          };
          const wick = (
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
          );
          const body = (
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
          );

          // Static fast path — once the reveal animation window is over,
          // no motion overhead. Zoom/pan re-renders touch only plain divs.
          if (!revealActive) {
            return (
              <div key={`${seriesKey}-${c.t}-${i}`} style={posStyle}>
                {wick}
                {body}
              </div>
            );
          }

          // Reveal active path.
          if (isInitialReveal) {
            // Slow, staggered draw-from-bottom with halo (login→home).
            const stagger =
              candles.length > 1
                ? (i / (candles.length - 1)) * INITIAL_STAGGER_TOTAL
                : 0;
            return (
              <div key={`${seriesKey}-${c.t}-${i}`} style={posStyle}>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 0.55, 0] }}
                  transition={{
                    duration: INITIAL_DUR,
                    delay: stagger,
                    times: [0, 0.5, 1],
                    ease: "easeOut",
                  }}
                  style={{
                    position: "absolute",
                    left: -bodyW * 0.6,
                    top: -4,
                    width: bodyW * 2.2,
                    height: candleH + 8,
                    background: color,
                    filter: "blur(7px)",
                    pointerEvents: "none",
                  }}
                />
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: candleH }}
                  transition={{
                    duration: INITIAL_DUR,
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
                    {wick}
                    {body}
                  </div>
                </motion.div>
              </div>
            );
          }

          // Fast fade — tf switch, no stagger / no halo.
          return (
            <motion.div
              key={`${seriesKey}-${c.t}-${i}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: FAST_DUR, ease: "easeOut" }}
              style={posStyle}
            >
              {wick}
              {body}
            </motion.div>
          );
        })}
      </div>

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
        WHEEL: K SPACING · DRAG: PAN · RIGHT-AXIS ↑↓: HEIGHT · 2×CLICK RESET
      </div>
    </div>
  );
}
