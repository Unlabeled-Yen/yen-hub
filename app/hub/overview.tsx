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

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { AttentionGrid } from "@/components/attention-grid";
import { TodoList } from "@/components/todo-list";
import { ReadingProgress } from "@/components/reading-progress";
import { MarketMonitor } from "@/components/market-monitor";

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
  // Seed with a realistic estimate so the slab + TODO container has a
  // stable height during initial paint. Without this readingH was null
  // → TODO had no fixed height → 0px container → bento cards rendered
  // tight against the slab → ResizeObserver fired → height settled to
  // ~600px → bento cards visibly jumped down. The estimate is replaced
  // by the real measurement after the first ResizeObserver tick.
  const [readingH, setReadingH] = useState<number>(620);
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
    return () => obs.disconnect();
  }, []);
  return (
    <motion.div
      className="flex flex-1 flex-col"
      // Inline opacity-0 to defeat the SSR-hydration flash where content
      // briefly paints at full opacity before motion's initial kicks in.
      // (The earlier K-candle blob was caused by a different bug — Stooq
      // fallback's 1-candle response with no width clamp — so this style
      // is safe.)
      style={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: RISE_DURATION, ease: "linear" }}
    >
      {/* Top spacer — just enough room for the overlay traffic lights
          (~28px tall). Tightened so the NY clock chip sits visually
          close to the US30 panel top edge. */}
      <div className="h-8" data-tauri-drag-region />

      <main className="flex-1 px-8 sm:px-12 py-1">
        {/* Natural-flow stack — each row sizes to its content, page scrolls
            if total height exceeds viewport. Reading is naturally sized;
            TODO's height is mirrored from Reading via JS measurement so
            the two bottoms always align. */}
        {/* gap-10 → gap-3 pulls the Reading / TODO row up so it sits
            closer to the US30 panel's bottom edge per Yen's spec.
            Inner slab still has its own py-16 for the gradient fade
            top/bottom. */}
        <div className="flex flex-col gap-3 pt-0">
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
          {/* Lower row: Reading natural-sized, TODO mirrors via JS.
              Wrapped in a subtle vertical-gradient panel so the whole
              attention-pair gets a quiet visual frame. */}
          <div
            className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 items-start py-16 -mx-8 sm:-mx-12 px-8 sm:px-12"
            style={{
              // Solid dark slab, bleeding to the page edges horizontally
              // and fading top/bottom only. Bumped vertical padding from
              // py-8 → py-16 so the gradient's transparent baseline sits
              // further outward (more breathing room before / after the
              // Reading + TODO row).
              background:
                "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.65) 10%, rgba(0,0,0,0.65) 90%, rgba(0,0,0,0) 100%)",
            }}
          >
            <motion.div
              ref={readingRef}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.0, ease: [0.075, 0.82, 0.165, 1], delay: 0.4 }}
              className="min-w-0"
            >
              <ReadingProgress />
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.0, ease: [0.075, 0.82, 0.165, 1], delay: 0.5 }}
              className="min-w-0"
              style={{
                height: `${readingH}px`,
              }}
            >
              <TodoList />
            </motion.div>
          </div>
        </div>

        {/* Bento module placeholders — sit below the fixed-height outer.
            Scroll the page to reveal them. */}
        <div
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 auto-rows-[140px] gap-4 mt-6"
          style={{ perspective: "1600px", perspectiveOrigin: "50% 30%" }}
        >
          {MODULES.map((m, i) => (
            <motion.div
              key={m.title}
              className={spanCls(m.span)}
              // Rise only — opacity is driven by the page-level fade so
              // both end together at RISE_DURATION. Strong ease-out:
              // cards launch upward quickly then settle long and slow.
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

      <CommandPalette />
    </motion.div>
  );
}
