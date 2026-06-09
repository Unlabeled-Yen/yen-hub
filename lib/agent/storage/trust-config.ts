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
  /** Slice 12 Phase 3 — per-kind tier promotions accepted by the user from
   *  the suggestion banner. Overrides the kind's static defaultTrustTier.
   *  Map: IntentKind → promoted TrustTier (typically "L0"). */
  kind_overrides?: Record<string, "L0" | "L1" | "L2">;
  /** Slice 12 Phase 4 — Auto-pilot Trust. When on, the runner upgrades /
   *  downgrades kinds automatically based on observed signals (no banner
   *  needed). Every change is written to auto-pilot-log.jsonl. Off by
   *  default — must be explicitly opted into. */
  auto_pilot?: boolean;
  /** ms — last time the auto-pilot evaluator ran. Used by the runner to
   *  enforce 24h cooldown between evaluations. */
  auto_pilot_last_run?: number;
  /** 方向 2 收尾 — when true, reminder schedule actions and stale-intention
   *  nudges fire a macOS notification so Yen sees them even when the .app
   *  window is closed. Opt-in to avoid surprise OS-level surface area. */
  notifications_enabled?: boolean;
  /** Telegram integration — token from BotFather. Empty/undefined → off. */
  telegram_bot_token?: string;
  /** Telegram chat id to send to (resolved once via getUpdates). */
  telegram_chat_id?: number;
  /** Master switch — must be true AND token+chat_id present to actually push. */
  telegram_enabled?: boolean;
  /** Long-poll cursor — tracks the next update_id to fetch from. */
  telegram_last_update_id?: number;
};

/** Default is "cautious" — opt-in for auto-execute. Users who want
 *  Slice 11.4 / 8.7B v2 behavior MUST explicitly flip the dial to
 *  "balanced" or "free". This avoids any surprise auto-write on first
 *  upgrade. */
const DEFAULT: TrustConfig = {
  mode: "cautious",
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
      kind_overrides:
        parsed.kind_overrides && typeof parsed.kind_overrides === "object"
          ? (parsed.kind_overrides as Record<string, "L0" | "L1" | "L2">)
          : undefined,
      auto_pilot: parsed.auto_pilot === true,
      auto_pilot_last_run:
        typeof parsed.auto_pilot_last_run === "number"
          ? parsed.auto_pilot_last_run
          : undefined,
      notifications_enabled: parsed.notifications_enabled === true,
      telegram_bot_token:
        typeof parsed.telegram_bot_token === "string"
          ? parsed.telegram_bot_token
          : undefined,
      telegram_chat_id:
        typeof parsed.telegram_chat_id === "number"
          ? parsed.telegram_chat_id
          : undefined,
      telegram_enabled: parsed.telegram_enabled === true,
      telegram_last_update_id:
        typeof parsed.telegram_last_update_id === "number"
          ? parsed.telegram_last_update_id
          : undefined,
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

/** Slice 12 Phase 3 — promote (or demote) a kind's tier. Persists to
 *  kind_overrides. Pass null to remove an override and revert to the
 *  static defaultTrustTier mapping. */
export async function setKindOverride(
  kind: string,
  tier: "L0" | "L1" | "L2" | null,
): Promise<TrustConfig> {
  const current = await load();
  if (!current.kind_overrides) current.kind_overrides = {};
  if (tier === null) {
    delete current.kind_overrides[kind];
  } else {
    current.kind_overrides[kind] = tier;
  }
  current.updated_at = Date.now();
  await save();
  return { ...current };
}

/** Slice 12 Phase 4 — toggle auto-pilot on/off. Doesn't roll back the
 *  overrides auto-pilot already applied (turning it off freezes the
 *  current state). */
export async function setAutoPilot(enabled: boolean): Promise<TrustConfig> {
  const current = await load();
  current.auto_pilot = enabled;
  current.updated_at = Date.now();
  await save();
  return { ...current };
}

/** Slice 12 Phase 4 — mark when the runner last evaluated. The runner
 *  uses this to enforce a 24h cooldown so it doesn't thrash on every
 *  scheduler tick. */
export async function markAutoPilotRun(): Promise<TrustConfig> {
  const current = await load();
  current.auto_pilot_last_run = Date.now();
  await save();
  return { ...current };
}

/** 方向 2 收尾 — toggle macOS notification side-effect on/off. */
export async function setNotifications(enabled: boolean): Promise<TrustConfig> {
  const current = await load();
  current.notifications_enabled = enabled;
  current.updated_at = Date.now();
  await save();
  return { ...current };
}

/** Telegram integration — set credentials + on/off in one call. Pass
 *  null/empty token to disable + wipe creds. */
export async function setTelegramConfig(args: {
  token?: string | null;
  chat_id?: number | null;
  enabled: boolean;
}): Promise<TrustConfig> {
  const current = await load();
  if (args.token !== undefined) {
    current.telegram_bot_token =
      args.token && args.token.trim().length > 0 ? args.token.trim() : undefined;
  }
  if (args.chat_id !== undefined) {
    current.telegram_chat_id = args.chat_id ?? undefined;
  }
  current.telegram_enabled =
    args.enabled && !!current.telegram_bot_token && !!current.telegram_chat_id;
  current.updated_at = Date.now();
  await save();
  return { ...current };
}

/** Update long-poll cursor after processing a batch of updates. */
export async function setTelegramLastUpdateId(id: number): Promise<void> {
  const current = await load();
  current.telegram_last_update_id = id;
  await save();
}

/* -------------------------------------------------------------------------- */
/*  Effective-action helper                                                    */
/* -------------------------------------------------------------------------- */

import type { Intent, TrustTier } from "./types";

export type EffectiveAction = "auto" | "approve" | "approve_with_confirm";

/** Resolve "what should happen to this intent right now" from its tier and
 *  the global trust mode. Used by the decide route + createIntent
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

/** Slice 12 Phase 3 — compute the effective tier for an intent, factoring
 *  in the user's per-kind overrides on top of the intent's static tier. */
export function tierForIntent(intent: Intent, cfg: TrustConfig): TrustTier {
  const override = cfg.kind_overrides?.[intent.kind];
  if (override) return override;
  return intent.trust_tier ?? "L1";
}
