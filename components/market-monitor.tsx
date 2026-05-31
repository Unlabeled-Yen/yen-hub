"use client";

/**
 * MarketMonitor — placeholder for the future US30 / VIX / volatility module.
 *
 * Sits top-right of Page A, paired horizontally with the attention chart.
 * For now, just reserves the visual slot with a labeled empty card so the
 * layout balances. When we wire Finnhub (or equivalent) we'll fill this
 * block with real quotes + sparklines.
 */

import { motion } from "motion/react";

const EASE: [number, number, number, number] = [0.075, 0.82, 0.165, 1];

export function MarketMonitor() {
  return (
    <section
      className="font-mono flex flex-col h-full"
      aria-label="market monitor"
      data-tauri-drag-region
    >
      <header className="flex items-center gap-3 text-[11px] tracking-[0.30em] uppercase text-[var(--fg-2)] mb-4 flex-shrink-0">
        <span>Market</span>
        <span style={{ opacity: 0.4 }}>—</span>
        <span style={{ opacity: 0.6 }}>US30 · VIX · 波動率</span>
      </header>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.45, ease: EASE }}
        className="relative flex-1"
        style={{
          minHeight: 360,
          borderRadius: 6,
          border: "1px dashed rgba(255,184,120,0.18)",
          background:
            "linear-gradient(180deg, rgba(255,184,120,0.04) 0%, rgba(255,184,120,0) 100%)",
          padding: "28px 24px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          className="text-[11px] tracking-[0.22em] uppercase"
          style={{ color: "rgba(255,184,120,0.65)" }}
        >
          Reserved
        </div>
        <div className="text-[12px] text-[var(--fg-1)]">
          US30 / VIX / 波動率 監控
        </div>
        <div className="text-[10px] text-[var(--fg-2)]" style={{ opacity: 0.65 }}>
          待接 Finnhub · 60s 輪詢 · 暖色 sparkline
        </div>
      </motion.div>
    </section>
  );
}
