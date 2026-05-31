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
import { useMemo } from "react";
import { CommandPalette } from "@/components/command-palette";

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
  return (
    <motion.div
      className="flex flex-1 flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: RISE_DURATION, ease: "linear" }}
    >
      {/* Top spacer — leaves room for the overlay traffic lights (~28px)
          since the Tauri window uses titleBarStyle: "Overlay". */}
      <div className="h-12" data-tauri-drag-region />

      <main className="flex-1 px-8 sm:px-12 py-6">
        <motion.div
          className="mb-8 flex items-center gap-2 text-[11px] font-mono tracking-[0.30em] text-[var(--fg-1)] uppercase select-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.9, delay: 1.0 }}
        >
          <span className="inline-block h-1 w-1 rounded-full bg-[var(--fg-2)] hairline-pulse" />
          type anywhere to talk · ⌘k to summon
        </motion.div>

        <div
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 auto-rows-[140px] gap-4"
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
