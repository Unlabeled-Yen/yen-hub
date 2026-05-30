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
const MODULES: ModuleDef[] = [
  {
    title: "Vault Health",
    hint: "筆記總數 / 草稿堆積 / 健康分數",
    span: { cols: 2, rows: 2 },
    flip: { rotateY: -78, delay: 0.15, originX: "0%" },
  },
  {
    title: "Pipelines",
    hint: "寫作 / 投資 / 學習 / 專案 進度與停滯",
    span: { cols: 2, rows: 3 },
    flip: { rotateX: -58, delay: 0.55, originY: "0%" },
  },
  {
    title: "Mirror",
    hint: "AI 對 Yen 的假設檔 · 可 ✓ / ✗",
    span: { cols: 2, rows: 2 },
    flip: { rotateX: 62, delay: 0.10, originY: "100%" },
  },
  {
    title: "Signals",
    hint: "地緣政治 / 訂閱 / 過濾後的外部訊號",
    span: { cols: 2, rows: 1 },
    flip: { rotateY: 84, delay: 0.85, originX: "100%" },
  },
  {
    title: "Open Loops",
    hint: "未完成承諾 · 從 Vault / 對話抓出",
    span: { cols: 2, rows: 1 },
    flip: { rotateX: -48, delay: 0.40, originY: "0%" },
  },
  {
    title: "Attention Map",
    hint: "本週時間實際花在哪 vs. 自評",
    span: { cols: 6, rows: 1 },
    flip: { rotateY: -90, delay: 0.70, originX: "0%" },
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

export function Overview() {
  return (
    <motion.div
      className="flex flex-1 flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.9, ease: "easeOut" }}
    >
      {/* top-left wordmark */}
      <motion.div
        className="px-8 sm:px-12 pt-8"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.0, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
      >
        <h1
          className="text-[26px] leading-none text-[var(--fg-0)] select-none"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Yen
        </h1>
      </motion.div>

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
          {MODULES.map((m) => (
            <motion.div
              key={m.title}
              className={spanCls(m.span)}
              initial={{
                opacity: 0,
                rotateX: m.flip.rotateX ?? 0,
                rotateY: m.flip.rotateY ?? 0,
                scale: 0.92,
              }}
              animate={{
                opacity: 1,
                rotateX: 0,
                rotateY: 0,
                scale: 1,
              }}
              transition={{
                duration: 1.4,
                ease: [0.16, 1, 0.3, 1],
                delay: m.flip.delay,
              }}
              style={{
                transformStyle: "preserve-3d",
                transformOrigin: `${m.flip.originX ?? "50%"} ${m.flip.originY ?? "50%"}`,
              }}
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
