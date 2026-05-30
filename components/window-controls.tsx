"use client";

/**
 * WindowControls — minimal top-right floating control strip.
 * For the frameless Tauri window: cycles background opacity.
 *
 * Click the `bg` chip to cycle through preset alphas.
 * The chosen alpha is written to:
 *   - document.documentElement style (--bg-alpha)
 *   - localStorage `yen-hub:bg-alpha`
 *
 * In a normal browser this still works — body becomes partially transparent
 * but the page underneath is the browser's own background, so it just looks
 * slightly muted.
 */

import { useEffect, useState } from "react";

const ALPHA_STEPS = [1.0, 0.85, 0.70, 0.55, 0.40] as const;
const STORAGE_KEY = "yen-hub:bg-alpha";

function readStored(): number {
  if (typeof window === "undefined") return 0.85;
  const raw = localStorage.getItem(STORAGE_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.85;
}

export function WindowControls() {
  const [alpha, setAlpha] = useState<number>(0.85);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const a = readStored();
    setAlpha(a);
    document.documentElement.style.setProperty("--bg-alpha", String(a));
  }, []);

  const cycle = () => {
    const idx = ALPHA_STEPS.findIndex((v) => Math.abs(v - alpha) < 0.01);
    const next = ALPHA_STEPS[(idx + 1) % ALPHA_STEPS.length];
    setAlpha(next);
    document.documentElement.style.setProperty("--bg-alpha", String(next));
    localStorage.setItem(STORAGE_KEY, String(next));
  };

  return (
    <div className="fixed top-2 right-3 z-[60] flex items-center gap-2 select-none">
      <button
        type="button"
        onClick={cycle}
        title="cycle window opacity"
        className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)] hover:text-[var(--fg-0)] transition-colors px-2 py-1 rounded hover:bg-white/5"
      >
        bg · {Math.round(alpha * 100)}
      </button>
    </div>
  );
}
