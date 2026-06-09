/**
 * Auto-pilot trust runner — Slice 12 Phase 4.
 *
 * When `trust-config.auto_pilot === true`, evaluates per-kind trust
 * signals once per 24h and applies promotions / demotions without asking.
 * Every change is written to auto-pilot-log.jsonl for audit.
 *
 * Thresholds (mirror banner thresholds where possible):
 *   PROMOTE (→ L0):   N ≥ 8   AND  approve_rate ≥ 0.92   AND  undo_rate ≤ 0.05
 *                     (slightly stricter than banner — auto needs more evidence
 *                      since user isn't confirming)
 *   DEMOTE  (L0 → L1): N_auto ≥ 4 AND undo_rate ≥ 0.30
 *                     OR rejected_rate ≥ 0.50 (rare for L0 since L0 doesn't card)
 *
 * Cooldown: each kind is locked for 7 days after any auto-pilot action,
 * preventing thrash if a few late rejects flip the rate.
 *
 * Hooks: called by scheduler.ts on each minute-tick (skips immediately if
 * < 24h since last run or auto_pilot disabled). Also called explicitly when
 * user toggles auto-pilot ON so they see instant first-pass results.
 */

import {
  getTrustConfig,
  setKindOverride,
  markAutoPilotRun,
  type TrustConfig,
} from "@/lib/agent/storage/trust-config";
import { statsByKindAndProposer } from "@/lib/agent/storage/trust-signals";
import {
  appendAutoPilotAction,
  lastActionForKind,
  type AutoPilotAction,
} from "@/lib/agent/storage/auto-pilot-log";
import { defaultTrustTier } from "@/lib/agent/storage/types";
import type { IntentKind, TrustTier } from "@/lib/agent/storage/types";

const EVAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PER_KIND_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const PROMOTE_MIN_N = 8;
const PROMOTE_RATE = 0.92;
const PROMOTE_MAX_UNDO = 0.05;

const DEMOTE_MIN_AUTO_N = 4;
const DEMOTE_UNDO_RATE = 0.3;
const DEMOTE_REJECT_RATE = 0.5;

type KindAgg = {
  kind: IntentKind;
  approved: number;
  rejected: number;
  auto_approved: number;
  auto_undone: number;
  total_decided: number;
  approve_rate: number;
  undo_rate: number;
  reject_rate: number;
};

function currentTier(cfg: TrustConfig, kind: IntentKind): TrustTier {
  return cfg.kind_overrides?.[kind] ?? defaultTrustTier(kind);
}

async function aggregateByKind(since: number): Promise<KindAgg[]> {
  const groups = await statsByKindAndProposer({ since });
  const byKind = new Map<IntentKind, KindAgg>();
  for (const g of groups) {
    let a = byKind.get(g.kind);
    if (!a) {
      a = {
        kind: g.kind,
        approved: 0,
        rejected: 0,
        auto_approved: 0,
        auto_undone: 0,
        total_decided: 0,
        approve_rate: 0,
        undo_rate: 0,
        reject_rate: 0,
      };
      byKind.set(g.kind, a);
    }
    a.approved += g.approved;
    a.rejected += g.rejected;
    a.auto_approved += g.auto_approved;
    a.auto_undone += g.auto_undone;
    a.total_decided += g.total_decided;
  }
  for (const a of byKind.values()) {
    const total = a.total_decided || 1;
    a.approve_rate = (a.approved + a.auto_approved) / total;
    a.reject_rate = a.rejected / total;
    a.undo_rate = a.auto_approved > 0 ? a.auto_undone / a.auto_approved : 0;
  }
  return Array.from(byKind.values());
}

/** Evaluate one kind. Returns the action to take (or null). */
function decide(a: KindAgg, cfg: TrustConfig): {
  to_tier: TrustTier;
  direction: "upgrade" | "downgrade";
  reason: string;
} | null {
  const cur = currentTier(cfg, a.kind);

  // Promotion: current is L1 (not L2 — never auto-promote to L0 from L2,
  // those are irreversible kinds) and stats clear the bar.
  if (
    cur === "L1" &&
    a.total_decided >= PROMOTE_MIN_N &&
    a.approve_rate >= PROMOTE_RATE &&
    a.undo_rate <= PROMOTE_MAX_UNDO
  ) {
    return {
      to_tier: "L0",
      direction: "upgrade",
      reason: `approve_rate=${a.approve_rate.toFixed(2)} N=${a.total_decided} undo_rate=${a.undo_rate.toFixed(2)} (≥ ${PROMOTE_RATE}, ≥${PROMOTE_MIN_N}, ≤${PROMOTE_MAX_UNDO})`,
    };
  }

  // Demotion: current is L0 (auto-running) and stats turned sour.
  if (cur === "L0") {
    if (a.auto_approved >= DEMOTE_MIN_AUTO_N && a.undo_rate >= DEMOTE_UNDO_RATE) {
      return {
        to_tier: "L1",
        direction: "downgrade",
        reason: `undo_rate=${a.undo_rate.toFixed(2)} N_auto=${a.auto_approved} (≥${DEMOTE_UNDO_RATE} of ≥${DEMOTE_MIN_AUTO_N})`,
      };
    }
    if (a.total_decided >= PROMOTE_MIN_N && a.reject_rate >= DEMOTE_REJECT_RATE) {
      return {
        to_tier: "L1",
        direction: "downgrade",
        reason: `reject_rate=${a.reject_rate.toFixed(2)} N=${a.total_decided} (≥${DEMOTE_REJECT_RATE})`,
      };
    }
  }

  return null;
}

/** Run one evaluation pass. Returns the number of actions taken. */
export async function evaluateAndApply(force: boolean = false): Promise<{
  evaluated: boolean;
  actions_taken: number;
  reason?: string;
}> {
  const cfg = await getTrustConfig();
  if (!cfg.auto_pilot) {
    return { evaluated: false, actions_taken: 0, reason: "auto_pilot is off" };
  }
  if (!force && cfg.auto_pilot_last_run) {
    const since = Date.now() - cfg.auto_pilot_last_run;
    if (since < EVAL_COOLDOWN_MS) {
      return {
        evaluated: false,
        actions_taken: 0,
        reason: `last run ${Math.round(since / 3_600_000)}h ago, cooldown 24h`,
      };
    }
  }

  const aggs = await aggregateByKind(Date.now() - WINDOW_MS);
  let actionsTaken = 0;

  for (const a of aggs) {
    // Per-kind cooldown
    const last = await lastActionForKind(a.kind);
    if (last && Date.now() - last < PER_KIND_COOLDOWN_MS) continue;

    const decision = decide(a, cfg);
    if (!decision) continue;

    const fromTier = currentTier(cfg, a.kind);
    if (fromTier === decision.to_tier) continue; // no-op

    await setKindOverride(a.kind, decision.to_tier);
    const action: AutoPilotAction = {
      ts: Date.now(),
      kind: a.kind,
      from_tier: fromTier,
      to_tier: decision.to_tier,
      direction: decision.direction,
      reason: decision.reason,
      stats_snapshot: {
        approved: a.approved,
        rejected: a.rejected,
        auto_approved: a.auto_approved,
        auto_undone: a.auto_undone,
        total: a.total_decided,
        approve_rate: a.approve_rate,
        undo_rate: a.undo_rate,
      },
    };
    await appendAutoPilotAction(action);
    actionsTaken++;
    console.log(
      `[auto-pilot] ${decision.direction} ${a.kind} ${fromTier} → ${decision.to_tier} (${decision.reason})`,
    );
  }

  await markAutoPilotRun();
  return { evaluated: true, actions_taken: actionsTaken };
}

/** Hook from scheduler.ts — fire-and-forget, swallows errors. */
export async function maybeRunAutoPilot(): Promise<void> {
  try {
    await evaluateAndApply(false);
  } catch (e) {
    console.warn("[auto-pilot] runner failed:", e);
  }
}
