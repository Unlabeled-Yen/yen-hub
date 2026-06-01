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

// ATR sub-pane geometry. Lives under the candle plot, shares the x-axis.
const ATR_H = 42; // pane height in px
const ATR_GAP = 6; // gap between candle plot and ATR pane
const ATR_PERIOD = 14;

// Moving averages — three SMAs in graduated muted green shades.
// Tuned down from the earlier vivid pass per Yen's spec: lower
// brightness, lower saturation, so the lines read as supplementary
// without competing with the K bars.
const MA_SERIES: Array<{ period: number; color: string }> = [
  { period: 5, color: "rgba(165,210,180,0.55)" }, // lightest, faded
  { period: 10, color: "rgba(125,180,150,0.70)" }, // mid muted
  { period: 20, color: "rgba(85,150,115,0.85)" }, // darkest — anchor
];

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
  // Candle plot height excludes the ATR pane + its gap underneath, so the
  // x-axis (time labels) stays at the very bottom (height - PAD_B).
  const plotH = Math.max(0, height - PAD_T - PAD_B - ATR_H - ATR_GAP);
  const midY = PAD_T + plotH / 2;
  const atrTop = PAD_T + plotH + ATR_GAP;
  const atrBottom = atrTop + ATR_H;

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
  // penDrawActive controls the left-to-right "ink stroke" animation on
  // the overlay lines (MA5/10/20, ATR). Only flips true on the very first
  // login → home reveal; tf swap doesn't trigger it.
  const [penDrawActive, setPenDrawActive] = useState(false);
  const seriesKey = `${timeframe}-${candles.length}-${candles[0]?.t ?? 0}`;
  useLayoutEffect(() => {
    if (candles.length === 0) return;
    if (lastSeriesKeyRef.current === seriesKey) return;
    lastSeriesKeyRef.current = seriesKey;
    const wasInitial = !firstShownRef.current;
    firstShownRef.current = true;
    setIsInitialReveal(wasInitial);
    setRevealActive(true);
    if (wasInitial) setPenDrawActive(true);
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
  // Pen-draw ends after the stroke completes — lines stay rendered as
  // plain paths afterwards (no motion overhead during zoom/pan).
  const PEN_DRAW_DUR = 2.8; // seconds — leisurely "ink stroke" pacing
  useEffect(() => {
    if (!penDrawActive) return;
    const t = window.setTimeout(
      () => setPenDrawActive(false),
      PEN_DRAW_DUR * 1000 + 80,
    );
    return () => window.clearTimeout(t);
  }, [penDrawActive]);

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
    // Hover region covers candle pane + ATR sub-pane (atrBottom is the
    // lower edge of the ATR pane). Outside that band → no hover.
    if (y < PAD_T || y > atrBottom || x < PAD_L || x > width - PAD_R) {
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

  // ATR(14) — Wilder's TR + simple moving average.
  // null entries for indices 0..period-2 where the window isn't full yet.
  const atrValues = useMemo<Array<number | null>>(() => {
    const N = candles.length;
    if (N === 0) return [];
    const trs: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
      if (i === 0) {
        trs[i] = candles[i].h - candles[i].l;
      } else {
        const cur = candles[i];
        const prev = candles[i - 1];
        trs[i] = Math.max(
          cur.h - cur.l,
          Math.abs(cur.h - prev.c),
          Math.abs(cur.l - prev.c),
        );
      }
    }
    const out: Array<number | null> = new Array(N).fill(null);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += trs[i];
      if (i >= ATR_PERIOD) sum -= trs[i - ATR_PERIOD];
      if (i >= ATR_PERIOD - 1) out[i] = sum / ATR_PERIOD;
    }
    return out;
  }, [candles]);

  // Min/max of ATR over the CURRENTLY visible window — keeps the pane's
  // y-axis tight to what the user is actually looking at.
  const atrRange = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < atrValues.length; i++) {
      const v = atrValues[i];
      if (v === null) continue;
      const x = xOf(i);
      if (x < PAD_L - candleWidth || x > width - PAD_R + candleWidth) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.12;
    return { lo: Math.max(0, lo - pad), hi: hi + pad };
  }, [atrValues, xOf, candleWidth, width]);

  function atrYOf(v: number): number {
    if (!atrRange) return atrBottom;
    const span = atrRange.hi - atrRange.lo;
    if (span <= 0) return atrBottom;
    return atrTop + ((atrRange.hi - v) / span) * ATR_H;
  }

  // SVG path for the ATR line (skips null leading values).
  const atrPath = useMemo(() => {
    if (!atrRange) return "";
    const parts: string[] = [];
    let started = false;
    for (let i = 0; i < atrValues.length; i++) {
      const v = atrValues[i];
      if (v === null) continue;
      const x = xOf(i);
      if (x < PAD_L - candleWidth || x > width - PAD_R + candleWidth) {
        started = false; // break the line at off-screen gaps
        continue;
      }
      const y = atrYOf(v);
      parts.push(`${started ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`);
      started = true;
    }
    return parts.join(" ");
    // atrYOf reads atrRange/atrTop/atrBottom which are recomputed each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atrValues, atrRange, xOf, candleWidth, width]);

  const hoveredATR =
    hoverGlobalIdx !== null && hoverGlobalIdx < atrValues.length
      ? atrValues[hoverGlobalIdx]
      : null;

  // MAs — for each series in MA_SERIES, compute the rolling SMA over its
  // period. Output is parallel to MA_SERIES: same indices, same colors.
  const maValues = useMemo<Array<Array<number | null>>>(() => {
    const N = candles.length;
    return MA_SERIES.map(({ period }) => {
      if (N === 0) return [] as Array<number | null>;
      const out: Array<number | null> = new Array(N).fill(null);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += candles[i].c;
        if (i >= period) sum -= candles[i - period].c;
        if (i >= period - 1) out[i] = sum / period;
      }
      return out;
    });
  }, [candles]);

  const maPaths = useMemo(() => {
    return maValues.map((values) => {
      const parts: string[] = [];
      let started = false;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null) continue;
        const x = xOf(i);
        if (x < PAD_L - candleWidth * 2 || x > width - PAD_R + candleWidth * 2) {
          started = false;
          continue;
        }
        const y = yOf(v);
        parts.push(`${started ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`);
        started = true;
      }
      return parts.join(" ");
    });
  }, [maValues, xOf, yOf, candleWidth, width]);

  // Hover values per MA series (null where the rolling window isn't yet
  // satisfied for that period at the hovered index).
  const hoveredMAs = maValues.map((vs) =>
    hoverGlobalIdx !== null && hoverGlobalIdx < vs.length
      ? vs[hoverGlobalIdx]
      : null,
  );

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
        <defs>
          {/* Clip overlay lines (MA, latest-price extension, etc.) to the
              candle plot area so they don't bleed into the ATR pane or
              right price axis when the user pans. */}
          <clipPath id="candle-plot-clip">
            <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH} />
          </clipPath>
        </defs>
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

        {/* MA overlays — three SMAs (period 5/10/20) in graduated muted
            green. Clipped to the candle plot so lines never bleed into
            the ATR pane or right axis during pan.
            On the first reveal, each line draws left-to-right via a
            pathLength 0→1 motion ("ink stroke"). After that they render
            as plain paths so zoom/pan stays cheap. */}
        <g pointerEvents="none" clipPath="url(#candle-plot-clip)">
          {maPaths.map((d, si) => {
            if (!d) return null;
            const stroke = MA_SERIES[si].color;
            const sw = si === MA_SERIES.length - 1 ? 1.35 : 1.05;
            if (penDrawActive) {
              return (
                <motion.path
                  key={`ma-${seriesKey}-${MA_SERIES[si].period}`}
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={sw}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{
                    pathLength: { duration: PEN_DRAW_DUR, ease: "easeOut" },
                    opacity: { duration: 0.18 },
                  }}
                />
              );
            }
            return (
              <path
                key={`ma-${MA_SERIES[si].period}`}
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={sw}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
          {/* Hover markers on each MA line */}
          {hoverGlobalIdx !== null && !dragging && !penDrawActive
            ? hoveredMAs.map((v, si) =>
                v !== null ? (
                  <circle
                    key={`ma-mark-${MA_SERIES[si].period}`}
                    cx={xOf(hoverGlobalIdx)}
                    cy={yOf(v)}
                    r={2.2}
                    fill={MA_SERIES[si].color}
                    stroke="rgba(0,0,0,0.6)"
                    strokeWidth={0.5}
                  />
                ) : null,
              )
            : null}
        </g>

        {/* Latest-price reference line + label on the right axis.
            Always visible (independent of hover) — a TradingView-style
            "current price" indicator. Colored to match up/down accent. */}
        {(() => {
          const last = candles[candles.length - 1];
          if (!last) return null;
          const y = yOf(last.c);
          // Skip if off-screen vertically (panned away, or below candle
          // pane into the ATR area).
          if (y < PAD_T - 4 || y > PAD_T + plotH + 4) return null;
          const labelW = 44;
          const labelH = 14;
          const labelX = width - PAD_R + 4;
          const labelY = y - labelH / 2;
          return (
            <g pointerEvents="none">
              <line
                x1={PAD_L}
                x2={width - PAD_R}
                y1={y}
                y2={y}
                stroke={accent}
                strokeWidth={0.8}
                strokeDasharray="3 3"
                opacity={0.7}
              />
              <rect
                x={labelX}
                y={labelY}
                width={labelW}
                height={labelH}
                fill={accent}
                rx={2}
              />
              <text
                x={labelX + labelW / 2}
                y={labelY + labelH - 4}
                fontSize={9.5}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fill="rgba(10,10,10,0.95)"
                fontWeight={700}
                textAnchor="middle"
                letterSpacing="0.02em"
              >
                {fmtPrice(last.c)}
              </text>
            </g>
          );
        })()}

        {hovered && hoverX !== null && hoverY !== null && !dragging ? (
          <g pointerEvents="none">
            {/* Vertical crosshair spans candle pane + ATR pane */}
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PAD_T}
              y2={atrBottom}
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

        {/* ATR sub-pane */}
        {atrRange && atrPath ? (
          <g pointerEvents="none">
            {/* Pane top separator + bottom baseline (super faint) */}
            <line
              x1={PAD_L}
              x2={width - PAD_R}
              y1={atrTop}
              y2={atrTop}
              stroke="rgba(255,255,255,0.05)"
              strokeWidth={1}
            />
            <line
              x1={PAD_L}
              x2={width - PAD_R}
              y1={atrBottom}
              y2={atrBottom}
              stroke="rgba(255,255,255,0.05)"
              strokeWidth={1}
            />
            {/* Mid grid */}
            <line
              x1={PAD_L}
              x2={width - PAD_R}
              y1={(atrTop + atrBottom) / 2}
              y2={(atrTop + atrBottom) / 2}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            {/* The ATR line itself — accent-toned to keep the palette
                coherent with the K bars, but at a softer opacity since
                ATR is supplementary context. On the first reveal,
                strokes left → right (pathLength animation), same timing
                as the MA lines. */}
            {penDrawActive ? (
              <motion.path
                key={`atr-${seriesKey}`}
                d={atrPath}
                fill="none"
                stroke="rgba(255,170,100,0.85)"
                strokeWidth={1.1}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{
                  pathLength: { duration: PEN_DRAW_DUR, ease: "easeOut" },
                  opacity: { duration: 0.18 },
                }}
              />
            ) : (
              <path
                d={atrPath}
                fill="none"
                stroke="rgba(255,170,100,0.85)"
                strokeWidth={1.1}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {/* Right-axis price labels for the ATR scale */}
            <text
              x={width - PAD_R + 6}
              y={atrTop + 7}
              fontSize={8.5}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fill={AXIS_FG}
              letterSpacing="0.04em"
            >
              {fmtPrice(atrRange.hi)}
            </text>
            <text
              x={width - PAD_R + 6}
              y={atrBottom - 1}
              fontSize={8.5}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fill={AXIS_FG}
              letterSpacing="0.04em"
            >
              {fmtPrice(atrRange.lo)}
            </text>
            {/* Pane label */}
            <text
              x={PAD_L + 2}
              y={atrTop + 9}
              fontSize={8.5}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              fill={AXIS_FG}
              letterSpacing="0.18em"
              fontWeight={500}
            >
              ATR(14)
            </text>
            {/* Hover marker on the ATR line at the hovered candle */}
            {hoverGlobalIdx !== null &&
            hoveredATR !== null &&
            hoverX !== null &&
            !dragging ? (
              <>
                <circle
                  cx={hoverX}
                  cy={atrYOf(hoveredATR)}
                  r={2.2}
                  fill="rgba(255,170,100,1)"
                  stroke="rgba(0,0,0,0.6)"
                  strokeWidth={0.5}
                />
                <text
                  x={width - PAD_R + 6}
                  y={atrYOf(hoveredATR) + 3}
                  fontSize={9}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fill="rgba(255,170,100,0.95)"
                  fontWeight={600}
                >
                  {fmtPrice(hoveredATR)}
                </text>
              </>
            ) : null}
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

      {/* Top-left OHLC info strip removed per spec — hover info still
          surfaces via the deep-hover pill and the right-axis price /
          MA / ATR markers. */}

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

      {/* Interaction-hint chip removed per spec — keep the chart clean. */}
    </div>
  );
}
