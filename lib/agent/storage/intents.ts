/**
 * Intent store — JSON overlay at
 * `~/Library/Application Support/com.yen.hub/intents.json`.
 *
 * Sibling to `lib/vault/done-store.ts`. Same in-memory-load-once + write-on-
 * mutation pattern. No external deps; tiny enough that re-writing the whole
 * file per mutation is fine at Slice 6 scale (< low thousands of intents).
 *
 * When the volume justifies it, swap this module for a SQLite-backed one —
 * the shape of the public API (list / get / create / decide) is what matters
 * to callers, not the storage.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type EvidenceRef,
  type Importance,
  type Intent,
  type IntentKind,
  type IntentPayload,
  type IntentStatus,
  type TrustTier,
  defaultTrustTier,
  newIntentId,
} from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "intents.json");

type IntentMap = Record<string, Intent>;

let mem: IntentMap | null = null;

// Always re-read from disk — no forever-cache. Real bug (2026-06-10, see
// schedules.ts): in Next standalone, API routes and instrumentation.ts
// bundle SEPARATE instances of this module. summary-cron / stale-intentions
// / schedule-actions create intents on the cron side; routes display them
// (and vice versa for decide). A boot-time cache lets each side silently
// miss the other's writes until restart. The file is small, mutations are
// rare, and the disk read is free.
async function load(): Promise<IntentMap> {
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as IntentMap;
  } catch {
    mem = mem ?? {};
  }
  return mem;
}

async function save(): Promise<void> {
  if (!mem) return;
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(mem, null, 2), "utf8");
  } catch {
    /* swallow — overlay write failures shouldn't break the app */
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function listIntents(filter?: {
  status?: IntentStatus;
  kind?: IntentKind;
  proposed_by?: string;
}): Promise<Intent[]> {
  const m = await load();
  let items = Object.values(m);
  if (filter?.status) items = items.filter((i) => i.status === filter.status);
  if (filter?.kind) items = items.filter((i) => i.kind === filter.kind);
  if (filter?.proposed_by)
    items = items.filter((i) => i.proposed_by === filter.proposed_by);
  return items.sort((a, b) => b.proposed_at - a.proposed_at);
}

export async function getIntent(id: string): Promise<Intent | undefined> {
  const m = await load();
  return m[id];
}

export async function createIntent(args: {
  kind: IntentKind;
  payload: IntentPayload;
  proposed_by: string;
  rationale: string;
  evidence?: EvidenceRef[];
  importance?: Importance;
  /** Slice 11.4 — explicit tier overrides the kind-based default. Omit
   *  for the standard mapping (see types.ts#defaultTrustTier). */
  trust_tier?: TrustTier;
}): Promise<Intent> {
  const m = await load();
  const intent: Intent = {
    id: newIntentId(),
    kind: args.kind,
    payload: args.payload,
    proposed_by: args.proposed_by,
    proposed_at: Date.now(),
    status: "pending",
    rationale: args.rationale,
    evidence: args.evidence ?? [],
    importance: args.importance ?? "medium",
    trust_tier: args.trust_tier ?? defaultTrustTier(args.kind),
  };
  m[intent.id] = intent;
  await save();

  // Slice 8.7B v2 — L0 auto-execute path.
  // Under "balanced" mode, L0 intents materialise immediately and skip the
  // pending queue. Under "cautious" (default), this branch is inert and
  // behavior matches pre-v2. Lazy import keeps the storage layer free of
  // a static dep on materializer / trust-config.
  try {
    const { getTrustConfig, effectiveAction, tierForIntent } = await import(
      "./trust-config"
    );
    const cfg = await getTrustConfig();
    const effectiveTier = tierForIntent(intent, cfg);
    const action = effectiveAction(effectiveTier, cfg.mode);
    if (action === "auto") {
      const { materializeIntent } = await import("../intent-materialize");
      const r = await materializeIntent(intent);
      if (r.ok) {
        intent.status = "approved";
        intent.decided_at = Date.now();
        intent.decided_by = "auto";
        if (r.resulted_in) intent.resulted_in = r.resulted_in;
        m[intent.id] = intent;
        await save();
        // Slice 12 Phase 2 — record the auto-approval as a trust signal.
        try {
          const { recordDecision } = await import("./trust-signals");
          await recordDecision({
            intent,
            decision: "auto_approved",
            decided_by: "auto",
          });
        } catch (e) {
          console.warn("[createIntent] auto-approve signal failed:", e);
        }
      } else {
        // Materialise failed under auto path — leave as pending so user
        // can still see + manually approve / inspect.
        console.warn(
          `[createIntent] auto-execute failed for ${intent.id}: ${r.error.message}`,
        );
      }
    }
  } catch (e) {
    // Trust-config / materialiser blew up — fall back to pending behavior.
    console.warn(`[createIntent] auto-execute path threw:`, e);
  }

  return intent;
}

/** Slice 11.4 — read tier from an Intent, defaulting legacy records to L1
 *  rather than the kind-based default. Legacy records predate the tier
 *  system; treating them as L1 preserves the original "approve everything"
 *  behavior they were created under. */
export function tierOf(intent: Intent): TrustTier {
  return intent.trust_tier ?? "L1";
}

export async function decideIntent(
  id: string,
  status: Extract<IntentStatus, "approved" | "rejected">,
  resulted_in?: string,
  decided_by: "user" | "auto" = "user",
): Promise<Intent | undefined> {
  const m = await load();
  const intent = m[id];
  if (!intent) return undefined;
  if (intent.status !== "pending") return intent; // idempotent — don't re-decide
  intent.status = status;
  intent.decided_at = Date.now();
  intent.decided_by = decided_by;
  if (resulted_in) intent.resulted_in = resulted_in;
  await save();

  // Slice 12 Phase 2 — append a trust signal. Best-effort: never blocks
  // the decision flow on a signal-log failure.
  try {
    const { recordDecision } = await import("./trust-signals");
    await recordDecision({
      intent,
      decision: status === "approved" ? "approved" : "rejected",
      decided_by,
    });
  } catch (e) {
    console.warn("[decideIntent] signal append failed:", e);
  }

  return intent;
}

/** Slice 8.7B v2 — used by undo endpoint. Marks an auto-executed intent as
 *  undone. Doesn't itself perform the side-effect reversal — that's the
 *  endpoint's job; this just records the fact. */
export async function markUndone(id: string): Promise<Intent | undefined> {
  const m = await load();
  const intent = m[id];
  if (!intent) return undefined;
  intent.undone_at = Date.now();
  await save();

  // Slice 12 Phase 2 — undo is a negative signal: Yen had to fix something
  // that auto-executed. Phase 3 banner uses this to suggest tier downgrades.
  try {
    const { recordDecision } = await import("./trust-signals");
    await recordDecision({
      intent,
      decision: "auto_undone",
      decided_by: "user",
    });
  } catch (e) {
    console.warn("[markUndone] signal append failed:", e);
  }

  return intent;
}

/** Test helper — wipe everything. Not exposed in API routes. */
export async function _clearAll(): Promise<void> {
  mem = {};
  await save();
}
