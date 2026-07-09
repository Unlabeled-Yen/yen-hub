/**
 * Intent store — SQLite table `intents` in
 * `~/Library/Application Support/com.yen.hub/yen-hub.db`.
 *
 * SPEC-01 (2026-07) — migrated off the intents.json overlay. Public API
 * signatures are unchanged (D4). `node:sqlite` is synchronous, so the
 * check-then-act sequences below (tryClaimIntentApproval / decideIntent /
 * revertIntentToPending / finalizeApproval) run as back-to-back prepared
 * statements with no `await` between the read and the write — nothing else
 * in this process can interleave in that gap, which is the same atomicity
 * the JSON version got from `withStoreLock`. Async work (trust-config,
 * materializeIntent, trust-signals) still happens between separate SQL
 * statements exactly like it did between separate lock sections before.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, importJsonOnce } from "./db";
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
const LEGACY_JSON = join(DIR, "intents.json");

const COLUMNS = [
  "id",
  "kind",
  "payload",
  "proposed_by",
  "proposed_at",
  "status",
  "rationale",
  "evidence",
  "importance",
  "decided_at",
  "decided_by",
  "resulted_in",
  "trust_tier",
  "undone_at",
];

type IntentRow = {
  id: string;
  kind: string;
  payload: string;
  proposed_by: string;
  proposed_at: number;
  status: string;
  rationale: string;
  evidence: string;
  importance: string;
  decided_at: number | null;
  decided_by: string | null;
  resulted_in: string | null;
  trust_tier: string | null;
  undone_at: number | null;
};

function rowToIntent(row: IntentRow): Intent {
  return {
    id: row.id,
    kind: row.kind as IntentKind,
    payload: JSON.parse(row.payload) as IntentPayload,
    proposed_by: row.proposed_by,
    proposed_at: row.proposed_at,
    status: row.status as IntentStatus,
    rationale: row.rationale,
    evidence: JSON.parse(row.evidence) as EvidenceRef[],
    importance: row.importance as Importance,
    decided_at: row.decided_at ?? undefined,
    decided_by: (row.decided_by as "user" | "auto" | null) ?? undefined,
    resulted_in: row.resulted_in ?? undefined,
    trust_tier: (row.trust_tier as TrustTier | null) ?? undefined,
    undone_at: row.undone_at ?? undefined,
  };
}

function intentToRow(i: Intent): (string | number | null)[] {
  return [
    i.id,
    i.kind,
    JSON.stringify(i.payload),
    i.proposed_by,
    i.proposed_at,
    i.status,
    i.rationale ?? "",
    JSON.stringify(i.evidence ?? []),
    // Pre-Slice-7A legacy records predate this field; the JSON store
    // tolerated the missing key (plain undefined property read), but a
    // SQLite bind rejects `undefined` outright. Default it the same way
    // createIntent does for new records.
    i.importance ?? "medium",
    i.decided_at ?? null,
    i.decided_by ?? null,
    i.resulted_in ?? null,
    i.trust_tier ?? null,
    i.undone_at ?? null,
  ];
}

let migrated = false;
function ensureMigrated(): void {
  if (migrated) return;
  // Only latch on success — a failed import (e.g. a bad legacy record) must
  // be retryable on the next call within this process, not stuck until
  // restart.
  importJsonOnce({
    table: "intents",
    jsonPath: LEGACY_JSON,
    columns: COLUMNS,
    parseEntries: (raw) => Object.values(JSON.parse(raw) as Record<string, Intent>),
    mapRow: (entry) => intentToRow(entry as Intent),
  });
  migrated = true;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function listIntents(filter?: {
  status?: IntentStatus;
  kind?: IntentKind;
  proposed_by?: string;
}): Promise<Intent[]> {
  ensureMigrated();
  const database = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter?.proposed_by) {
    clauses.push("proposed_by = ?");
    params.push(filter.proposed_by);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database
    .prepare(`SELECT * FROM intents ${where} ORDER BY proposed_at DESC`)
    .all(...params) as unknown as IntentRow[];
  return rows.map(rowToIntent);
}

export async function getIntent(id: string): Promise<Intent | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM intents WHERE id = ?")
    .get(id) as IntentRow | undefined;
  return row ? rowToIntent(row) : undefined;
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
  ensureMigrated();
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
  const database = getDb();
  const placeholders = COLUMNS.map(() => "?").join(", ");
  database
    .prepare(`INSERT INTO intents (${COLUMNS.join(", ")}) VALUES (${placeholders})`)
    .run(...intentToRow(intent));

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
        database
          .prepare(
            "UPDATE intents SET status = ?, decided_at = ?, decided_by = ?, resulted_in = ? WHERE id = ?",
          )
          .run(
            intent.status,
            intent.decided_at,
            intent.decided_by,
            intent.resulted_in ?? null,
            intent.id,
          );
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
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM intents WHERE id = ?")
    .get(id) as IntentRow | undefined;
  if (!row) return undefined;
  const intent = rowToIntent(row);
  let transitioned = false;
  if (intent.status === "pending") {
    intent.status = status;
    intent.decided_at = Date.now();
    intent.decided_by = decided_by;
    if (resulted_in) intent.resulted_in = resulted_in;
    database
      .prepare(
        "UPDATE intents SET status = ?, decided_at = ?, decided_by = ?, resulted_in = ? WHERE id = ?",
      )
      .run(
        intent.status,
        intent.decided_at,
        intent.decided_by,
        intent.resulted_in ?? null,
        id,
      );
    transitioned = true;
  } // else: idempotent, already decided

  // Slice 12 Phase 2 — append a trust signal. Best-effort: never blocks
  // the decision flow on a signal-log failure. Only on a real transition —
  // an idempotent re-decide shouldn't double-log.
  if (transitioned) {
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
  }

  return intent;
}

/**
 * Atomically claim a pending intent for approval. Flips pending→approved
 * inside a single synchronous read-then-write and returns the intent IFF
 * this caller won the race; returns null if it was already decided
 * (another surface got there first).
 *
 * Closes the check-then-act TOCTOU where two surfaces — a Telegram "存" reply
 * and the in-app approve button — both pass a `status === "pending"` check and
 * then BOTH run `materializeIntent`, double-applying side effects. Callers
 * materialize AFTER a successful claim; on materialize failure they call
 * `revertIntentToPending(id)`, and on success `finalizeApproval(id, …)` to
 * stamp `resulted_in` and log the trust signal. No signal is recorded here so a
 * materialize failure + revert leaves no spurious "approved" in trust stats.
 */
export async function tryClaimIntentApproval(
  id: string,
  decided_by: "user" | "auto" = "user",
): Promise<Intent | null> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM intents WHERE id = ?")
    .get(id) as IntentRow | undefined;
  if (!row) return null;
  const intent = rowToIntent(row);
  if (intent.status !== "pending") return null;
  intent.status = "approved";
  intent.decided_at = Date.now();
  intent.decided_by = decided_by;
  database
    .prepare(
      "UPDATE intents SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?",
    )
    .run(intent.status, intent.decided_at, intent.decided_by, id);
  return intent;
}

/** Undo a claim when materialization fails — back to pending so it can be
 *  re-approved later. Clears the decision stamps set by the claim. */
export async function revertIntentToPending(id: string): Promise<void> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM intents WHERE id = ?")
    .get(id) as IntentRow | undefined;
  if (!row) return;
  database
    .prepare(
      "UPDATE intents SET status = 'pending', decided_at = NULL, decided_by = NULL, resulted_in = NULL WHERE id = ?",
    )
    .run(id);
}

/** Finish a claimed approval after a successful materialize: stamp
 *  `resulted_in` and append the (single) "approved" trust signal. */
export async function finalizeApproval(
  id: string,
  resulted_in: string | undefined,
  decided_by: "user" | "auto" = "user",
): Promise<void> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM intents WHERE id = ?")
    .get(id) as IntentRow | undefined;
  if (!row) return;
  const intent = rowToIntent(row);
  if (resulted_in) {
    intent.resulted_in = resulted_in;
    database
      .prepare("UPDATE intents SET resulted_in = ? WHERE id = ?")
      .run(resulted_in, id);
  }
  try {
    const { recordDecision } = await import("./trust-signals");
    await recordDecision({ intent, decision: "approved", decided_by });
  } catch (e) {
    console.warn("[finalizeApproval] signal append failed:", e);
  }
}

/** Slice 8.7B v2 — used by undo endpoint. Marks an auto-executed intent as
 *  undone. Doesn't itself perform the side-effect reversal — that's the
 *  endpoint's job; this just records the fact. */
export async function markUndone(id: string): Promise<Intent | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM intents WHERE id = ?")
    .get(id) as IntentRow | undefined;
  if (!row) return undefined;
  const intent = rowToIntent(row);
  intent.undone_at = Date.now();
  database
    .prepare("UPDATE intents SET undone_at = ? WHERE id = ?")
    .run(intent.undone_at, id);

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
  ensureMigrated();
  getDb().prepare("DELETE FROM intents").run();
}
