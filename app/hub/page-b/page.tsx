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
 * Inherits the hub layout (auth + WorldClock badge top-right).
 */

import Link from "next/link";
import { CoachCard } from "@/components/page-b/coach-card";
import { MarkHighReadOnMount } from "@/components/page-b/mark-high-read-on-mount";
import { SilhouetteView } from "@/components/page-b/silhouette-view";
import { SoulView } from "@/components/page-b/soul-view";
import { SummaryView } from "@/components/page-b/summary-view";
import { generateCoachCard } from "@/lib/agent/duffy/coach";

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

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-10 gap-y-20">
          {/* 01 · 今日 — full bleed, the dateline of the page */}
          <section className="lg:col-span-12">
            <SectionMark num="01" name="今日" />
            <CoachCard initial={initialCoach} />
          </section>

          {/* 02 · 剪影 — left 7 cols, sits beside 03 on wide screens */}
          <section className="lg:col-span-7">
            <SectionMark num="02" name="剪影" />
            <SilhouetteView />
          </section>

          {/* 03 · 本週摘要 — right 5 cols, narrower so numbers read */}
          <section className="lg:col-span-5">
            <SectionMark num="03" name="本週摘要" />
            <SummaryView />
          </section>

          {/* 04 · SOUL — full bleed, the long-form bottom */}
          <section className="lg:col-span-12">
            <SectionMark num="04" name="SOUL" />
            <SoulView />
          </section>
        </div>

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
