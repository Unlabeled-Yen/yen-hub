/**
 * /hub/page-b — Duffy's dedicated space.
 *
 * Flat-design pass (Slice 8.9, 2026-06-03):
 *   - Full-bleed layout matching the home page (overview.tsx) — no
 *     centered max-w container; padding is viewport-driven (px-8 sm:px-12)
 *   - 12-col grid with asymmetric spans so the eye reads rhythm, not table
 *   - Numbered section spine: 01 · 今日 / 02 · 剪影 / 03 · 本週摘要 / 04 · SOUL
 *   - Single accent (mint --accent) for section numbers + hairline rules
 *
 * Slice 8.7 Phase A (2026-06-09):
 *   - SensorStrip above 01 — shows what Duffy is "seeing" right now
 *   - 02 · 待辦卡片 inserted (intent queue) — existing sections renumber
 *   - 06 · 排程 appended at the tail — autonomous schedule list
 *
 * Inherits the hub layout (auth + WorldClock badge top-right).
 */

import Link from "next/link";
import { CoachCard } from "@/components/page-b/coach-card";
import { IntentQueue } from "@/components/page-b/intent-queue";
import { MarkHighReadOnMount } from "@/components/page-b/mark-high-read-on-mount";
import { MemoryTabs } from "@/components/page-b/memory-tabs";
import { SchedulesPanel } from "@/components/page-b/schedules-panel";
import { SensorStrip } from "@/components/page-b/sensor-strip";
import { generateCoachCard } from "@/lib/agent/duffy/coach";

// Force per-request rendering. Without this, Next bakes the page (and
// `generateCoachCard()`'s result) at build time — when no LLM env exists —
// freezing the "（無 LLM key）" fallback into the static HTML. Every cold
// navigation back to page-b would then show that fallback until the
// client-side refetch lands, looking like the LLM key kept disappearing.
export const dynamic = "force-dynamic";

/** Numbered hairline section mark — sits above each block. */
function SectionMark({
  num,
  name,
}: {
  num: string;
  name: string;
}) {
  return (
    <div className="flex items-baseline gap-3 mb-5">
      <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--accent)]">
        {num}
      </span>
      <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
        {name}
      </span>
      <div className="flex-1 h-px bg-[var(--fg-3)] opacity-30" />
    </div>
  );
}

export default async function PageB() {
  // Slice 8.12 — server-side fetch the coach card so the page HTML
  // already contains today's message. Zero "loading…" flash even on
  // first visit after .app restart (disk cache lives in
  // ~/Library/Application Support/com.yen.hub/coach.json).
  // If generation fails (e.g., LLM down), we pass null and the client
  // falls back to its own fetch / loading state.
  let initialCoach = null;
  try {
    initialCoach = await generateCoachCard();
  } catch {
    /* silent — client will retry */
  }
  return (
    <div className="min-h-screen px-8 sm:px-12 py-14">
      {/* ── Header — same width discipline as home (full-bleed, just inset) ── */}
      <header className="mb-20 flex items-end justify-between">
        <div>
          <h1
            className="text-[120px] leading-[0.85] tracking-tight text-[var(--fg-0)] select-none"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Duffy
          </h1>
          <p className="mt-4 text-[11px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
            你的副駕 · personal copilot
          </p>
        </div>
        <Link
          href="/hub"
          className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] hover:text-[var(--fg-0)] transition-colors"
        >
          ← home
        </Link>
      </header>

      {/* ── Main — 12-col asymmetric grid, full viewport width ─────── */}
      <main>
        <MarkHighReadOnMount />

        {/* Sensor strip — slim banner, unnumbered. */}
        <SensorStrip />

        {/* ── Tier 1: 行動 + 對話（並排，最大視覺權重）─────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-8 gap-y-10 mb-14">
          {/* 01 · 今日 — left 8 cols, Duffy's voice for today */}
          <section className="lg:col-span-8">
            <SectionMark num="01" name="今日" />
            <CoachCard initial={initialCoach} />
          </section>

          {/* 02 · 待辦 — right 4 cols, narrow sidebar of pending intents */}
          <section className="lg:col-span-4">
            <SectionMark num="02" name="待辦" />
            <IntentQueue />
          </section>
        </div>

        {/* ── Tier 2: 排程（緊湊條狀儀表）──────────────────────────── */}
        <section className="mb-14">
          <SectionMark num="03" name="排程" />
          <SchedulesPanel />
        </section>

        {/* ── Tier 3: 記憶（合併 tabbed、預設折疊風格的低調區）────── */}
        <section>
          <SectionMark num="04" name="記憶" />
          <MemoryTabs />
        </section>

        {/* Tail rule — closes the page without dangling. */}
        <div className="mt-20">
          <div className="h-px bg-[var(--fg-3)] opacity-20" />
          <p className="mt-3 text-center text-[9px] font-mono tracking-[0.32em] uppercase text-[var(--fg-3)]">
            END · 由 Duffy 自動編成
          </p>
        </div>
      </main>
    </div>
  );
}
