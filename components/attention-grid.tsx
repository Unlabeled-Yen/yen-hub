"use client";

/**
 * AttentionGrid — Page A 的「本週注意力」鏡子。
 *
 * 排序長條圖：每個 zone 兩條 bar 堆疊（進 / 翻），按 added 降序。
 * 囤積 zone（ratio > 3 或 opened = 0）的「進」bar 染暖色。
 * 對角線、象限等空間編碼移除 — 純粹用長度比較，最忠實。
 *
 * 動畫：寬度 0 → target，stagger 80ms/列，opened bar 比 added bar 慢 100ms。
 *
 * 資料：GET /api/vault/attention?days=7
 */

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { parseBook as parseBookName } from "@/lib/vault/book-translations";
import { EASE } from "@/lib/animation/constants";
import { DuffyBadge } from "@/components/page-b/duffy-badge";
import type {
  AttentionResponse,
  BookSummary,
  Zone,
  ZoneBreakdown,
} from "@/lib/vault/attention-types";

const PINNED: Zone[] = [
  "library",
  "septic",
  "workshop",
  "yenhub",
  "queue",
];

const EMOJI: Record<Zone, string> = {
  library: "📚",
  septic: "⚠️",
  workshop: "🔧",
  yenhub: "🏗",
  writing: "✍️",
  trading: "💹",
  queue: "📥",
  indexes: "🗂",
  derived: "🪜",
  drafts: "📝",
  other: "•",
};

const SHORT: Record<Zone, string> = {
  library: "閱讀",
  septic: "筆記摘錄",
  workshop: "AI建造",
  yenhub: "Yen Hub",
  writing: "主筆記",
  trading: "交易",
  queue: "寫作",
  indexes: "索引",
  derived: "加工",
  drafts: "草稿",
  other: "其他",
};

// --- column chart geometry -----------------------------------------------
const COL_W = 28; // each column width in px (slimmer = less mass)
const COL_H = 320; // chart height — taller now that lower row is fixed
const COL_GAP = 22; // gap between columns (more air around slim columns)
const BAR_DUR = 2.5; // slower draw
const ROW_STAGGER = 0.18;
const FILL_OFFSET = 0.024; // fill barely trails pen (was 0.08, now -70%)
const HOARD_OFFSET = 0.15; // hoard segment trails consumed slightly
const PLOT_MIN = 1; // zones with added+opened below this go to the QuietStrip

function isHoarding(z: ZoneBreakdown): boolean {
  return z.added > 0 && (z.opened === 0 || z.added / z.opened > 3);
}

type Severity = "absent" | "review" | "advance" | "mild" | "heavy" | "severe";

function severityOf(z: ZoneBreakdown): Severity {
  if (z.added === 0 && z.opened === 0) return "absent";
  if (z.opened > z.added) return "review";
  if (z.opened === 0) return "severe";
  const r = z.added / z.opened;
  if (r > 5) return "heavy";
  if (r > 2) return "mild";
  return "advance";
}

/** Solid color used as the "drawing pen" leading edge for each severity. */
function penColor(sev: Severity): string {
  switch (sev) {
    case "severe":
      return "rgba(255,110,70,1)";
    case "heavy":
      return "rgba(255,150,90,1)";
    case "mild":
      return "rgba(255,200,140,1)";
    case "advance":
      return "rgba(220,235,245,1)";
    case "review":
      return "rgba(160,200,255,1)";
    default:
      return "transparent";
  }
}

/** Color for the single bar — severity scales red → orange → pale → neutral.
 *  Gradient strong at the bottom (column floor) fading toward the top. */
function barGradient(sev: Severity): string {
  switch (sev) {
    case "severe":
      return "linear-gradient(to top, rgba(255,110,70,1) 0%, rgba(255,110,70,0.5) 50%, rgba(255,110,70,0) 100%)";
    case "heavy":
      return "linear-gradient(to top, rgba(255,150,90,1) 0%, rgba(255,150,90,0.5) 50%, rgba(255,150,90,0) 100%)";
    case "mild":
      return "linear-gradient(to top, rgba(255,200,140,0.95) 0%, rgba(255,200,140,0.45) 50%, rgba(255,200,140,0) 100%)";
    case "advance":
      // Healthy zones get cool neutral white — clearly distinct from warm
      return "linear-gradient(to top, rgba(220,235,245,0.95) 0%, rgba(220,235,245,0.45) 50%, rgba(220,235,245,0) 100%)";
    case "review":
      return "linear-gradient(to top, rgba(160,200,255,0.92) 0%, rgba(160,200,255,0.5) 50%, rgba(160,200,255,0) 100%)";
    default:
      // absent — no bar visible
      return "transparent";
  }
}

function barShadow(sev: Severity): string {
  switch (sev) {
    case "severe":
      return "drop-shadow(0 0 2px rgba(255,110,70,0.7)) drop-shadow(0 0 8px rgba(255,110,70,0.30))";
    case "heavy":
      return "drop-shadow(0 0 2px rgba(255,150,90,0.65)) drop-shadow(0 0 7px rgba(255,150,90,0.28))";
    case "mild":
      return "drop-shadow(0 0 2px rgba(255,200,140,0.55)) drop-shadow(0 0 6px rgba(255,200,140,0.22))";
    case "advance":
      return "drop-shadow(0 0 2px rgba(220,235,245,0.55)) drop-shadow(0 0 6px rgba(220,235,245,0.22))";
    case "review":
      return "drop-shadow(0 0 2px rgba(160,200,255,0.55)) drop-shadow(0 0 8px rgba(160,200,255,0.22))";
    default:
      return "none";
  }
}

function ratioLabel(z: ZoneBreakdown): string {
  if (z.added === 0 && z.opened === 0) return "—";
  if (z.opened === 0) return "∞";
  const r = z.added / z.opened;
  if (r >= 10) return `${r.toFixed(0)}×`;
  return `${r.toFixed(1)}×`;
}

function actionVerb(zone: Zone): { added: string; opened: string } {
  switch (zone) {
    case "library":
      return { added: "進", opened: "讀" };
    case "septic":
      return { added: "倒", opened: "回" };
    case "writing":
    case "trading":
      return { added: "寫", opened: "翻" };
    case "workshop":
      return { added: "動", opened: "翻" };
    default:
      return { added: "動", opened: "翻" };
  }
}

/**
 * Vertical column for one zone. Two segments grow from their bases toward
 * the middle:
 *   - Consumed (bright) lives at the BOTTOM. Strong at floor, fades UP.
 *   - Hoarded (warm) stacks ABOVE consumed. Strong at top, fades DOWN.
 * The two fades meet face-to-face at the consumed/hoarded boundary, so the
 * transition reads as a soft dissolve rather than a hard seam.
 */
function ZoneColumn({
  z,
  scaleMax,
  index,
}: {
  z: ZoneBreakdown;
  scaleMax: number;
  index: number;
}) {
  // Base offset shifts all columns so the LAST one ends at the global
  // entry T_END=3.5s. Last col: index 4 × 0.18 + 2.5 = 3.22 → add 0.28
  // base so 0.28 + 3.22 = 3.50.
  const delay = index * ROW_STAGGER + 0.28;
  const inactive = z.added === 0 && z.opened === 0;
  const isReview = z.opened > z.added;
  const sev = severityOf(z);

  // Bar height = added (or opened for review case)
  const barValue = isReview ? z.opened : z.added;
  const barPct = `${(barValue / scaleMax) * 100}%`;

  return (
    <div className="flex flex-col items-center" style={{ width: COL_W }}>
      {/* Single bar — height encodes weekly activity, color encodes severity */}
      <div
        className="relative"
        style={{
          width: "100%",
          height: COL_H,
        }}
      >
        {!inactive ? (
          <>
            {/* Drawing pen — bright glowing line that scans upward, the
                "ink tip" tracing the bar's height. Uses transform
                (translateY) instead of `bottom: %`: the previous
                percentage-bottom animation hit layout reflow every frame
                plus the heavy box-shadow had to repaint, which caused
                visible flicker. Transform is GPU-accelerated and stable. */}
            <motion.div
              initial={{ y: 0, opacity: 0 }}
              animate={{
                y: -(barValue / scaleMax) * COL_H,
                opacity: [0, 1, 1, 0],
              }}
              transition={{
                y: { duration: BAR_DUR, ease: "linear", delay },
                opacity: {
                  duration: BAR_DUR,
                  delay,
                  times: [0, 0.08, 0.85, 1],
                  ease: "linear",
                },
              }}
              style={{
                position: "absolute",
                left: -1,
                right: -1,
                bottom: 0,
                height: 1.5,
                background: penColor(sev),
                boxShadow: `0 0 6px ${penColor(sev)}, 0 0 14px ${penColor(sev)}`,
                borderRadius: 1,
                willChange: "transform, opacity",
                zIndex: 2,
                pointerEvents: "none",
              }}
            />
            {/* Fill — emerges right behind the pen (offset reduced 70%) */}
            <motion.div
              initial={{ height: "0%" }}
              animate={{ height: barPct }}
              transition={{
                duration: BAR_DUR,
                ease: EASE,
                delay: delay + FILL_OFFSET,
              }}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                background: barGradient(sev),
                borderRadius: 2,
                filter: barShadow(sev),
                willChange: "height",
              }}
            />
          </>
        ) : null}
      </div>

      {/* Label block beneath the column — name + counts.
          No emoji. No gray. Plain bright text. */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: delay + 0.4 }}
        className="mt-3 text-center font-mono"
        style={{ minWidth: COL_W }}
      >
        <div className="text-[10px] tracking-[0.10em] text-[var(--fg-0)] whitespace-nowrap">
          {SHORT[z.zone]}
        </div>
        <div className="text-[10px] tabular-nums text-[var(--fg-0)] mt-0.5">
          {z.added}/{z.opened}
        </div>
      </motion.div>
    </div>
  );
}

// MirrorSentence removed — diagnosis lives in the bar colors.

// QuietStrip removed — chart focuses on the 5 pinned zones only.

// Translation map + display moved to lib/vault/book-translations.ts —
// see top-of-file imports.

/**
 * Reading progress block — graphic-design-correct layout.
 *
 * Per book:
 *   - Title (largest, fg-0)
 *   - Author (smaller, fg-2)             — right-aligned chapter count
 *   - Progress bar (full width)          — percentage label inline
 *
 * Books separated by ample vertical space (not crammed inline).
 * Section header uppercase tracked for hierarchy.
 */
function BookProgressBlock({
  b,
  index,
}: {
  b: BookSummary;
  index: number;
}) {
  const { author, title } = parseBookName(b.name);
  const pct = b.chapters === 0 ? 0 : b.openedChapters / b.chapters;
  const pctLabel = `${Math.round(pct * 100)}%`;
  const delay = 0.9 + index * 0.08;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay, ease: EASE }}
      className="font-mono"
    >
      {/* Title + chapter count — same baseline, justify-between */}
      <div className="flex items-baseline gap-3">
        <h4 className="text-[13px] text-[var(--fg-0)] leading-tight flex-1 truncate">
          {title}
        </h4>
        <span className="text-[11px] text-[var(--fg-1)] tabular-nums whitespace-nowrap">
          {b.openedChapters} / {b.chapters}
        </span>
      </div>

      {/* Author — secondary line */}
      {author ? (
        <div className="text-[10px] text-[var(--fg-2)] tracking-[0.08em] mt-0.5">
          {author}
        </div>
      ) : null}

      {/* Progress bar + percentage — visual encoding */}
      <div className="mt-2.5 flex items-center gap-3">
        <span
          className="relative flex-1"
          style={{
            height: 3,
            background: "rgba(255,255,255,0.06)",
            borderRadius: 1.5,
            overflow: "hidden",
          }}
        >
          <motion.span
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(2, pct * 100)}%` }}
            transition={{ duration: 0.9, ease: EASE, delay: delay + 0.15 }}
            style={{
              display: "block",
              height: "100%",
              background: "rgba(140,220,200,0.85)",
              borderRadius: 1.5,
            }}
          />
        </span>
        <span
          className="text-[10px] text-[var(--fg-2)] tabular-nums"
          style={{ minWidth: "3em", textAlign: "right" }}
        >
          {pctLabel}
        </span>
      </div>
    </motion.div>
  );
}

function LibraryDetail({ library }: { library: AttentionResponse["library"] }) {
  if (library.activelyReading.length === 0) return null;
  return (
    <section className="mt-8 pt-6 border-t border-white/[0.05]">
      <header className="font-mono text-[11px] tracking-[0.30em] uppercase text-[var(--fg-2)] mb-5">
        正在讀
      </header>
      <div className="space-y-5">
        {library.activelyReading.slice(0, 4).map((b, i) => (
          <BookProgressBlock key={b.path} b={b} index={i} />
        ))}
      </div>
    </section>
  );
}

export function AttentionGrid({
  data,
}: {
  /** Parent (Overview) fetches /api/vault/attention once and passes
   *  the same payload here AND to ReadingProgress so the vault file-
   *  system isn't scanned twice on first paint. null = still loading. */
  data: AttentionResponse | null;
}) {
  if (!data) {
    return (
      <div className="font-mono text-[12px] text-[var(--fg-2)] tracking-[0.30em] uppercase">
        attention · loading
      </div>
    );
  }

  // Strict: only the PINNED zones plot, in PINNED order. No auto-add of
  // active non-pinned zones (writing / drafts / indexes etc. stay invisible).
  const byZone = new Map(data.zones.map((z) => [z.zone, z]));
  const plotted: ZoneBreakdown[] = [];
  for (const z of PINNED) {
    const found = byZone.get(z);
    if (found) plotted.push(found);
  }

  const scaleMax = Math.max(1, ...plotted.map((z) => Math.max(z.added, z.opened)));

  return (
    <section
      className="space-y-4"
      aria-label="weekly attention"
      data-tauri-drag-region
    >
      {/* Duffy entry — sits where the "past N days · 本週注意力" header
          used to be. Header text was removed per Yen 2026-06-02 because it
          carried no information the chart didn't already convey. */}
      <DuffyBadge />
      <div
        className="relative flex items-end"
        style={{ gap: COL_GAP, paddingTop: 8 }}
      >
        {/* Subtle noise wash BEHIND the columns. z:0 + columns wrapped
            in z:1 so the noise sits underneath instead of greying out
            the bars. Opacity dropped from 0.18 → 0.04 because at high
            baseFrequency the noise averages to flat gray at viewing
            scale (was reading as a solid gray block before). */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ opacity: 0.04, zIndex: 0 }}
          preserveAspectRatio="none"
        >
          <defs>
            <filter id="attn-grain">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.85"
                numOctaves="2"
                seed="7"
                stitchTiles="stitch"
              />
              <feColorMatrix
                values="0 0 0 0 1
                        0 0 0 0 1
                        0 0 0 0 1
                        0 0 0 1 0"
              />
            </filter>
          </defs>
          <rect width="100%" height="100%" filter="url(#attn-grain)" />
        </svg>
        <div
          className="flex items-end relative"
          style={{ gap: COL_GAP, zIndex: 1 }}
        >
          {plotted.map((z, i) => (
            <ZoneColumn key={z.zone} z={z} scaleMax={scaleMax} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}
