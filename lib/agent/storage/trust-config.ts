/**
 * Trust config — Slice 8.7B v1.
 *
 * Stores the global "trust mode" that governs how each tier behaves:
 *
 *   cautious — every intent requires approval (L0/L1/L2 all gated).
 *              This is the pre-Slice-11.4 behavior; the safe default for
 *              users who want full oversight.
 *
 *   balanced — L0 auto-executes (append-only / easy-undo); L1+L2 require
 *              approval. Default after the dial first ships. Solves the
 *              "approve fatigue" complaint without surrendering the
 *              risky tiers.
 *
 *   free     — L0+L1 auto-execute; L2 requires approval (+ second
 *              confirmation in a future v2). For users who trust Duffy
 *              enough that observations/todos/files create themselves.
 *
 * The store is intentionally tiny — one JSON object, no per-tool overrides
 * yet. Capability Matrix (per-tool tier override + enable/disable) lands
 * in Slice 8.7B v2.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "trust-config.json");

export type TrustMode = "cautious" | "balanced" | "free";

export type TrustConfig = {
  mode: TrustMode;
  /** ms — when the mode was last changed. Useful for "你 N 天沒調過了" UX. */
  updated_at: number;
};

const DEFAULT: TrustConfig = {
  mode: "balanced",
  updated_at: 0,
};

let mem: TrustConfig | null = null;

async function load(): Promise<TrustConfig> {
  if (mem) return mem;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<TrustConfig>;
    mem = {
      mode:
        parsed.mode === "cautious" ||
        parsed.mode === "balanced" ||
        parsed.mode === "free"
          ? parsed.mode
          : DEFAULT.mode,
      updated_at: typeof parsed.updated_at === "number" ? parsed.updated_at : 0,
    };
  } catch {
    mem = { ...DEFAULT };
  }
  return mem;
}

async function save(): Promise<void> {
  if (!mem) return;
  await fs.mkdir(DIR, { recursive: true });
  const tmp = FILE + ".tmp-" + Date.now();
  await fs.writeFile(tmp, JSON.stringify(mem, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

export async function getTrustConfig(): Promise<TrustConfig> {
  return { ...(await load()) };
}

export async function setTrustMode(mode: TrustMode): Promise<TrustConfig> {
  const current = await load();
  current.mode = mode;
  current.updated_at = Date.now();
  await save();
  return { ...current };
}

/* -------------------------------------------------------------------------- */
/*  Effective-action helper                                                    */
/* -------------------------------------------------------------------------- */

import type { TrustTier } from "./types";

export type EffectiveAction = "auto" | "approve" | "approve_with_confirm";

/** Resolve "what should happen to this intent right now" from its tier and
 *  the global trust mode. Used by the decide route + (future) createIntent
 *  auto-execute path. */
export function effectiveAction(
  tier: TrustTier,
  mode: TrustMode,
): EffectiveAction {
  if (mode === "cautious") {
    return tier === "L2" ? "approve_with_confirm" : "approve";
  }
  if (mode === "balanced") {
    if (tier === "L0") return "auto";
    if (tier === "L2") return "approve_with_confirm";
    return "approve";
  }
  // free
  if (tier === "L2") return "approve_with_confirm";
  return "auto";
}
