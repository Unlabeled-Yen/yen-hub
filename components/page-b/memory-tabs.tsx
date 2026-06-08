"use client";

/**
 * MemoryTabs — Slice 8.7 Phase A.2 (information-architecture pass).
 *
 * Bundles the three "memory" surfaces (剪影 / 本週摘要 / SOUL) into a single
 * tabbed block. Reasoning: all three are slow-changing reference material
 * about Duffy's model of Yen — they share the "memory" property, update on
 * weekly cadence at most, and don't need three full-bleed sections each.
 *
 * Default tab: 剪影 (highest "user importance" among the three).
 * Lazy mounting: only the active tab renders, keeps DOM light.
 */

import { useState } from "react";
import { SilhouetteView } from "@/components/page-b/silhouette-view";
import { SoulView } from "@/components/page-b/soul-view";
import { SummaryView } from "@/components/page-b/summary-view";

type TabKey = "silhouette" | "summary" | "soul";

const TABS: { key: TabKey; label: string }[] = [
  { key: "silhouette", label: "剪影" },
  { key: "summary", label: "本週摘要" },
  { key: "soul", label: "SOUL" },
];

export function MemoryTabs() {
  const [active, setActive] = useState<TabKey>("silhouette");

  return (
    <div>
      {/* Tab bar — mirror the SectionMark visual language (mono, tracked,
          accent for active). Sits inside the section frame. */}
      <div className="flex items-center gap-6 mb-6">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              className={`relative text-[10px] font-mono tracking-[0.28em] uppercase transition-colors ${
                isActive
                  ? "text-[var(--fg-0)]"
                  : "text-[var(--fg-3)] hover:text-[var(--fg-1)]"
              }`}
            >
              {tab.label}
              {isActive && (
                <span
                  className="absolute -bottom-[6px] left-0 right-0 h-px"
                  style={{ background: "var(--accent)" }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Body — only the active tab renders */}
      <div>
        {active === "silhouette" && <SilhouetteView />}
        {active === "summary" && <SummaryView />}
        {active === "soul" && <SoulView />}
      </div>
    </div>
  );
}
