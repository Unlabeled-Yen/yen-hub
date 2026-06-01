"use client";

/**
 * Overview — single dense canvas, edge-to-edge.
 *
 * Layout philosophy (post Yen feedback 2026-05-30):
 *   Panels are full-bleed with thin viewport padding — no centered max-width.
 *   Bento-style asymmetric grid: each module gets a different col/row span so
 *   the eye reads variety rather than a uniform table.
 *
 * Entry choreography: each card flips in from a different 3D axis with
 * intentionally irregular stagger.
 */

import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { AttentionGrid } from "@/components/attention-grid";
import { TodoList } from "@/components/todo-list";
import { ReadingProgress } from "@/components/reading-progress";
import { MarketMonitor } from "@/components/market-monitor";
import { WorldClock } from "@/components/world-clock";

type Span = { cols?: number; rows?: number };
type ModuleDef = {
  title: string;
  hint: string;
  span: Span;
  flip: { rotateX?: number; rotateY?: number; delay: number; originX?: string; originY?: string };
};

/**
 * Bento layout target — 6 cols × 4 rows on lg+
 * (Visual rhythm; tweak as real modules land.)
 *
 *   +---------+----+--------+
 *   | Vault   | P  | Mirror |     (row 1-2)
 *   |  H      | I  |        |
 *   +---------+ P  +--------+
 *   | Signals | E  | Open L |     (row 3)
 *   +---------+ L  +--------+
 *   |  Attention Map         |    (row 4 - wide)
 *   +-------------------------+
 */
// "Door swing" entry angles — close to ±90° so each card opens like a
// hinged panel from its respective edge. Delays are randomized on mount
// (see useState initializer below) so the order shuffles each load.
const MODULES: ModuleDef[] = [
  {
    title: "Vault Health",
    hint: "筆記總數 / 草稿堆積 / 健康分數",
    span: { cols: 2, rows: 2 },
    flip: { rotateY: -88, delay: 0, originX: "0%" }, // hinge LEFT
  },
  {
    title: "Pipelines",
    hint: "寫作 / 投資 / 學習 / 專案 進度與停滯",
    span: { cols: 2, rows: 3 },
    flip: { rotateX: -85, delay: 0, originY: "0%" }, // hinge TOP
  },
  {
    title: "Mirror",
    hint: "AI 對 Yen 的假設檔 · 可 ✓ / ✗",
    span: { cols: 2, rows: 2 },
    flip: { rotateX: 85, delay: 0, originY: "100%" }, // hinge BOTTOM
  },
  {
    title: "Signals",
    hint: "地緣政治 / 訂閱 / 過濾後的外部訊號",
    span: { cols: 2, rows: 1 },
    flip: { rotateY: 88, delay: 0, originX: "100%" }, // hinge RIGHT
  },
  {
    title: "Open Loops",
    hint: "未完成承諾 · 從 Vault / 對話抓出",
    span: { cols: 2, rows: 1 },
    flip: { rotateX: -85, delay: 0, originY: "0%" }, // hinge TOP
  },
  {
    title: "Attention Map",
    hint: "本週時間實際花在哪 vs. 自評",
    span: { cols: 6, rows: 1 },
    flip: { rotateY: -88, delay: 0, originX: "0%" }, // hinge LEFT
  },
];

const SLICE_OF = {
  "vault health": "5",
  pipelines: "6",
  mirror: "7",
  signals: "8",
  "open loops": "9",
  "attention map": "10",
} as const;

function ModuleCard({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="module-card group relative flex h-full flex-col rounded-2xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] font-mono tracking-[0.30em] text-[var(--fg-0)] uppercase">
          {title}
        </span>
        <span className="text-[11px] font-mono tracking-[0.30em] text-[var(--fg-2)] uppercase">
          —
        </span>
      </div>
      <p className="text-[13px] font-mono text-[var(--fg-1)] leading-relaxed">
        {hint}
      </p>
      <div className="mt-auto pt-8">
        <div className="text-[11px] font-mono tracking-[0.30em] text-[var(--fg-2)] uppercase">
          placeholder · slice {SLICE_OF[title.toLowerCase() as keyof typeof SLICE_OF] ?? "?"}
        </div>
      </div>
    </div>
  );
}

/** Build inline grid-area string from span (responsive — only applied at md+). */
function spanCls(span: Span): string {
  const c = span.cols ?? 1;
  const r = span.rows ?? 1;
  // Tailwind v4 still needs explicit utility classes for grid spans
  const colMap: Record<number, string> = {
    1: "md:col-span-1",
    2: "md:col-span-2",
    3: "md:col-span-3",
    4: "md:col-span-4",
    5: "md:col-span-5",
    6: "md:col-span-6",
  };
  const rowMap: Record<number, string> = {
    1: "md:row-span-1",
    2: "md:row-span-2",
    3: "md:row-span-3",
    4: "md:row-span-4",
  };
  return `${colMap[c] ?? ""} ${rowMap[r] ?? ""}`.trim();
}

/** Random delay 0–0.9s per card, regenerated on every page mount.
 *  useMemo with empty deps = runs once on mount, deterministic for the
 *  lifetime of this Overview instance. */
function useShuffledDelays(count: number): number[] {
  return useMemo(
    () => Array.from({ length: count }, () => Math.random() * 0.3),
    [count],
  );
}

/** Shared timing — page fade and card rise both ride this curve. */
const RISE_DURATION = 1.1;
// Strong ease-out: fast initial acceleration, long quiet settle.
const RISE_EASE: [number, number, number, number] = [0.075, 0.82, 0.165, 1];

export function Overview() {
  const delays = useShuffledDelays(MODULES.length);
  // Measure Reading's height so TODO can match it (CSS Grid can't align
  // bottoms when items have wildly different natural heights). Reading sits
  // at its content's natural size; TODO's `height` is mirrored from JS.
  const readingRef = useRef<HTMLDivElement | null>(null);
  // Seed with a tight estimate of ReadingProgress's actual layout:
  //   header (~17px text + 20px mb) + cube (380px) ≈ 417px.
  // Previous 620 estimate caused TODO to render way taller than reading
  // while data was loading / before ResizeObserver fired, so the
  // review tab (45 items) extended down close to the carousel dots
  // instead of aligning with reading's bottom edge.
  const [readingH, setReadingH] = useState<number>(420);
  useEffect(() => {
    const node = readingRef.current;
    if (!node) return;
    const update = () => {
      const r = node.getBoundingClientRect();
      if (r.height > 0) setReadingH(r.height);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(node);
    // One delayed remeasure to catch any post-data layout shift the
    // RO might miss (data fetch + cube spin + initial paint all settle
    // by ~2s; remeasure at 2.5s as a backstop).
    const t = window.setTimeout(update, 2500);
    return () => {
      obs.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  // Horizontal page carousel (page 0 = home, page 1 = bento modules).
  // Trigger: horizontal wheel input (Mac trackpad two-finger swipe OR
  // mouse with horizontal wheel). NO drag — Yen disabled click-and-drag
  // since it added unwanted friction.
  const PAGE_COUNT = 2;
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  const [vw, setVw] = useState<number>(
    typeof window === "undefined" ? 1200 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const carouselX = useMotionValue(0);
  useEffect(() => {
    const controls = animate(carouselX, -page * vw, {
      type: "spring",
      stiffness: 220,
      damping: 28,
    });
    return () => controls.stop();
  }, [page, vw, carouselX]);

  // Wheel-driven page change. Accumulates horizontal deltaX from the
  // carousel container; once it crosses THRESH the page flips and the
  // accumulator resets. cooldownRef debounces so one big trackpad
  // flick (which fires many wheel events in quick succession) flips
  // exactly one page, not several.
  const carouselContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = carouselContainerRef.current;
    if (!el) return;
    const THRESH = 90; // px of accumulated deltaX
    const COOLDOWN = 600; // ms — block further flips while page settles
    let accum = 0;
    let cooldownUntil = 0;
    let resetTimer: number | null = null;
    const handler = (e: WheelEvent) => {
      // Only react to horizontal wheel intent. Vertical wheels pass
      // through to the inner page's own scroll.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const now = Date.now();
      if (now < cooldownUntil) return;
      accum += e.deltaX;
      // Auto-reset the accumulator after a brief idle so partial swipes
      // don't accumulate forever across separate gestures.
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => (accum = 0), 200);
      if (accum >= THRESH) {
        accum = 0;
        cooldownUntil = now + COOLDOWN;
        setPage((p) => Math.min(PAGE_COUNT - 1, p + 1));
      } else if (accum <= -THRESH) {
        accum = 0;
        cooldownUntil = now + COOLDOWN;
        setPage((p) => Math.max(0, p - 1));
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => {
      el.removeEventListener("wheel", handler);
      if (resetTimer !== null) window.clearTimeout(resetTimer);
    };
  }, []);
  return (
    <motion.div
      className="flex flex-1 flex-col relative"
      // Inline opacity-0 to defeat the SSR-hydration flash where content
      // briefly paints at full opacity before motion's initial kicks in.
      // (The earlier K-candle blob was caused by a different bug — Stooq
      // fallback's 1-candle response with no width clamp — so this style
      // is safe.) `relative` anchors the absolute-positioned WorldClock
      // below.
      style={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: RISE_DURATION, ease: "linear" }}
    >
      {/* NY clock — pinned to top-right of the outer flex container,
          OUTSIDE the carousel's overflow-y:auto. Previously mounted
          inside MarketMonitor at top:-22 but the main element's
          overflow-y:auto clipped it. */}
      <div
        className="absolute z-30 pointer-events-none"
        style={{ top: 10, right: 24 }}
      >
        <WorldClock />
      </div>
      {/* Top spacer — just enough room for the overlay traffic lights
          (~28px tall). Tightened so the NY clock chip sits visually
          close to the US30 panel top edge. */}
      <div className="h-8" data-tauri-drag-region />

      {/* Horizontal carousel — driven by horizontal wheel events
          (Mac trackpad two-finger swipe + mouse with horizontal wheel).
          No drag per Yen's spec. Carousel container catches wheel and
          accumulates deltaX; once threshold reached, snap to next/prev
          page. Vertical wheel passes through to inner page scroll. */}
      <div
        className="flex-1 relative overflow-hidden"
        ref={carouselContainerRef}
      >
      <motion.div
        className="absolute inset-0 flex"
        style={{
          x: carouselX,
          width: `${PAGE_COUNT * 100}vw`,
        }}
      >
        {/* Page 1 — Home (existing content) */}
        <main
          className="shrink-0 w-screen h-full px-8 sm:px-12 py-1 overflow-y-auto hub-scrollbar"
        >
          <div className="flex flex-col gap-2 pt-0">
            {/* Upper row: chart at max-content, market fills the rest */}
            <div className="grid grid-cols-1 lg:grid-cols-[max-content_1fr] gap-x-10 items-stretch flex-shrink-0">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, ease: "linear", delay: 0 }}
                className="min-w-0"
              >
                <AttentionGrid />
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1.0, ease: [0.075, 0.82, 0.165, 1], delay: 0.3 }}
                className="min-w-0 h-full"
              >
                <MarketMonitor />
              </motion.div>
            </div>
            {/* Lower row: Reading + TODO inside the dark slab.
                Slab content (reading + todo) stays exactly where it
                was. To pull the gradient START point upward (per Yen)
                without moving content, an ABSOLUTE child renders the
                gradient and extends 260px above the slab into the
                chart area.
                  - pointer-events: none on the extension so chart
                    hover/wheel still works through the transparent
                    upper portion
                  - gradient: transparent at top (chart mid-line) →
                    opaque by ~38% (= 260 / (260+~420) of total) →
                    opaque to bottom (no fade-out at bottom)
                Slab itself: position:relative anchors the absolute
                child; no own background; original padding/grid kept. */}
            <div
              className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 items-start py-4 -mx-8 sm:-mx-12 px-8 sm:px-12 relative"
            >
              <div
                aria-hidden
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: -260,
                  bottom: 0,
                  background:
                    "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.65) 38%, rgba(0,0,0,0.65) 100%)",
                }}
              />
              <div ref={readingRef} className="min-w-0 relative">
                <ReadingProgress />
              </div>
              <div
                className="min-w-0 relative"
                style={{ height: `${readingH}px` }}
              >
                <TodoList />
              </div>
            </div>
          </div>
        </main>

        {/* Page 2 — Bento modules. Swipe right or drag left to reach. */}
        <main
          className="shrink-0 w-screen h-full px-8 sm:px-12 py-1 overflow-y-auto hub-scrollbar"
        >
          <div
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 auto-rows-[140px] gap-4"
            style={{ perspective: "1600px", perspectiveOrigin: "50% 30%" }}
          >
            {MODULES.map((m, i) => (
              <motion.div
                key={m.title}
                className={spanCls(m.span)}
                initial={{ y: 75 }}
                animate={{ y: 0 }}
                transition={{
                  duration: RISE_DURATION,
                  ease: RISE_EASE,
                  delay: delays[i],
                }}
                style={{ willChange: "transform" }}
              >
                <ModuleCard title={m.title} hint={m.hint} />
              </motion.div>
            ))}
          </div>
        </main>
      </motion.div>
      {/* Page indicator dots — click to jump. Sits centered at the
          very bottom of the viewport, above all carousel content. */}
      <nav
        className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 z-10"
        aria-label="page indicator"
        style={{ bottom: 16 }}
      >
        {Array.from({ length: PAGE_COUNT }).map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setPage(i)}
            aria-label={`page ${i + 1}`}
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background:
                i === page
                  ? "rgba(255,184,120,0.9)"
                  : "rgba(255,255,255,0.18)",
              boxShadow:
                i === page ? "0 0 6px rgba(255,184,120,0.55)" : "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              transition: "background 240ms, box-shadow 240ms",
            }}
          />
        ))}
      </nav>
      </div>

      <CommandPalette />
    </motion.div>
  );
}
