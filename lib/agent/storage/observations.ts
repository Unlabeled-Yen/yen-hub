/**
 * Observation store — SQLite table `observations` in
 * `~/Library/Application Support/com.yen.hub/yen-hub.db`.
 *
 * Observations are the *result* of an approved observation-intent.
 * They're append-only at Slice 6 (no edit / no delete in API). If Yen wants
 * to retract one, that becomes a follow-up intent in a later slice.
 *
 * SPEC-01 (2026-07) — migrated off the observations.json overlay. Public API
 * signatures are unchanged (D4); see db.ts for the schema + one-time JSON
 * import. `node:sqlite` is synchronous and single-threaded, so a same-process
 * read-modify-write (e.g. supersedeObservation, touchIntention) never
 * interleaves with another call the way the old JSON load/mutate/save did —
 * no store lock needed here.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, importJsonOnce } from "./db";
import {
  type EvidenceRef,
  type Importance,
  type IntentionMeta,
  type Observation,
  newObservationId,
} from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const LEGACY_JSON = join(DIR, "observations.json");

const COLUMNS = [
  "id",
  "source_intent",
  "title",
  "body",
  "zone",
  "window_days",
  "evidence",
  "source",
  "source_agent_id",
  "reason",
  "created_at",
  "importance",
  "read_at",
  "intention",
  "nudge_for",
  "valid_until",
  "superseded_by",
  "archived_at",
];

type ObservationRow = {
  id: string;
  source_intent: string;
  title: string;
  body: string;
  zone: string | null;
  window_days: number | null;
  evidence: string;
  source: string;
  source_agent_id: string | null;
  reason: string;
  created_at: number;
  importance: string;
  read_at: number | null;
  intention: string | null;
  nudge_for: string | null;
  valid_until: number | null;
  superseded_by: string | null;
  archived_at: number | null;
};

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    source_intent: row.source_intent,
    title: row.title,
    body: row.body,
    zone: row.zone ?? undefined,
    window: row.window_days != null ? { days: row.window_days } : undefined,
    evidence: JSON.parse(row.evidence) as EvidenceRef[],
    source: row.source as Observation["source"],
    source_agent_id: row.source_agent_id ?? undefined,
    reason: row.reason,
    created_at: row.created_at,
    importance: row.importance as Importance,
    read_at: row.read_at ?? undefined,
    intention: row.intention
      ? (JSON.parse(row.intention) as IntentionMeta)
      : undefined,
    nudge_for: row.nudge_for ?? undefined,
    valid_until: row.valid_until ?? undefined,
    superseded_by: row.superseded_by ?? undefined,
    archived_at: row.archived_at ?? undefined,
  };
}

function observationToRow(o: Observation): (string | number | null)[] {
  return [
    o.id,
    o.source_intent,
    o.title,
    o.body,
    o.zone ?? null,
    o.window?.days ?? null,
    JSON.stringify(o.evidence ?? []),
    o.source,
    o.source_agent_id ?? null,
    // Legacy pre-Slice-7A records may lack these — the JSON store tolerated
    // the missing key, but a SQLite bind rejects `undefined` outright.
    o.reason ?? "",
    o.created_at,
    o.importance ?? "medium",
    o.read_at ?? null,
    o.intention ? JSON.stringify(o.intention) : null,
    o.nudge_for ?? null,
    o.valid_until ?? null,
    o.superseded_by ?? null,
    o.archived_at ?? null,
  ];
}

let migrated = false;
function ensureMigrated(): void {
  if (migrated) return;
  // Only latch on success — a failed import (e.g. a bad legacy record) must
  // be retryable on the next call within this process, not stuck until
  // restart.
  importJsonOnce({
    table: "observations",
    jsonPath: LEGACY_JSON,
    columns: COLUMNS,
    parseEntries: (raw) => Object.values(JSON.parse(raw) as Record<string, Observation>),
    mapRow: (entry) => observationToRow(entry as Observation),
  });
  migrated = true;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * v2 Gap A (2026-06-16) — is this observation still "active" memory?
 * Inactive = explicitly superseded/archived, or past its valid_until.
 * Pure + cheap; used as the default read filter so stale memory stops
 * polluting Duffy's context and searches without anyone having to prune.
 */
export function isActive(o: Observation, now: number = Date.now()): boolean {
  if (o.superseded_by || o.archived_at) return false;
  if (o.valid_until != null && now >= o.valid_until) return false;
  return true;
}

export async function listObservations(filter?: {
  agent?: string;
  zone?: string;
  since?: number; // epoch ms
  /** v2 Gap A: include superseded/expired. Default false — reads see only
   *  active memory. Pass true for audit/admin views. */
  includeArchived?: boolean;
}): Promise<Observation[]> {
  ensureMigrated();
  const database = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.agent) {
    clauses.push("source_agent_id = ?");
    params.push(filter.agent);
  }
  if (filter?.zone) {
    clauses.push("zone = ?");
    params.push(filter.zone);
  }
  if (filter?.since) {
    clauses.push("created_at >= ?");
    params.push(filter.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database
    .prepare(`SELECT * FROM observations ${where} ORDER BY created_at DESC`)
    .all(...params) as unknown as ObservationRow[];
  let items = rows.map(rowToObservation);
  if (!filter?.includeArchived) {
    const now = Date.now();
    items = items.filter((o) => isActive(o, now));
  }
  return items;
}

/**
 * v2 Gap A — mark `oldId` as superseded by `newId` (sets superseded_by +
 * archived_at). Idempotent; no-op if already superseded or absent. The vault
 * Markdown mirror of the old observation is intentionally NOT touched — Yen's
 * vault is sacred ground; the JSON overlay is the queryable memory.
 */
export async function supersedeObservation(
  oldId: string,
  newId: string,
): Promise<Observation | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM observations WHERE id = ?")
    .get(oldId) as ObservationRow | undefined;
  if (!row) return undefined;
  const obs = rowToObservation(row);
  if (obs.superseded_by) return obs; // idempotent
  obs.superseded_by = newId;
  obs.archived_at = Date.now();
  database
    .prepare(
      "UPDATE observations SET superseded_by = ?, archived_at = ? WHERE id = ?",
    )
    .run(obs.superseded_by, obs.archived_at, oldId);
  return obs;
}

export async function getObservation(
  id: string,
): Promise<Observation | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM observations WHERE id = ?")
    .get(id) as ObservationRow | undefined;
  return row ? rowToObservation(row) : undefined;
}

/**
 * Create an observation from an approved intent.
 * Caller (decide route) is responsible for ensuring the intent was approved.
 */
export async function createObservationFromIntent(args: {
  intent_id: string;
  title: string;
  body: string;
  zone?: string;
  window?: { days: number };
  evidence: EvidenceRef[];
  source_agent_id: string; // "duffy"
  reason: string;
  importance: Importance;
  intention?: IntentionMeta;  // Slice 8
  nudge_for?: string;         // Slice 8
  valid_until?: number;       // v2 Gap A
}): Promise<Observation> {
  ensureMigrated();
  const obs: Observation = {
    id: newObservationId(),
    source_intent: args.intent_id,
    title: args.title,
    body: args.body,
    zone: args.zone,
    window: args.window,
    evidence: args.evidence,
    source: "agent",
    source_agent_id: args.source_agent_id,
    reason: args.reason,
    created_at: Date.now(),
    importance: args.importance,
    intention: args.intention,
    nudge_for: args.nudge_for,
    valid_until: args.valid_until,
  };
  const database = getDb();
  const placeholders = COLUMNS.map(() => "?").join(", ");
  database
    .prepare(
      `INSERT INTO observations (${COLUMNS.join(", ")}) VALUES (${placeholders})`,
    )
    .run(...observationToRow(obs));
  return obs;
}

/**
 * Bump an observation's intention.last_touched_at to now. Used when Yen
 * re-mentions an intention so it stops being "stale". Idempotent.
 */
export async function touchIntention(id: string): Promise<Observation | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM observations WHERE id = ?")
    .get(id) as ObservationRow | undefined;
  if (!row) return undefined;
  const obs = rowToObservation(row);
  if (!obs.intention) return undefined;
  obs.intention = { ...obs.intention, last_touched_at: Date.now() };
  database
    .prepare("UPDATE observations SET intention = ? WHERE id = ?")
    .run(JSON.stringify(obs.intention), id);
  return obs;
}

/**
 * Slice 8.7B v2 — delete an observation, used by the undo endpoint when an
 * L0 auto-executed intent is rolled back. Returns the deleted record (or
 * undefined if absent). The Markdown mirror in vault is NOT removed
 * automatically — Yen's vault is sacred ground, we don't reach in. The
 * undo endpoint surfaces this caveat to the caller.
 */
export async function deleteObservation(id: string): Promise<Observation | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM observations WHERE id = ?")
    .get(id) as ObservationRow | undefined;
  if (!row) return undefined;
  database.prepare("DELETE FROM observations WHERE id = ?").run(id);
  return rowToObservation(row);
}

/** List observations that carry an open/in_progress intention. */
export async function listIntentionObservations(): Promise<Observation[]> {
  ensureMigrated();
  const database = getDb();
  const rows = database
    .prepare("SELECT * FROM observations WHERE intention IS NOT NULL")
    .all() as unknown as ObservationRow[];
  return rows
    .map(rowToObservation)
    .filter(
      (o) =>
        o.intention &&
        (o.intention.status === "open" || o.intention.status === "in_progress"),
    );
}

/** Mark an observation as read (clears the unread-HIGH badge). */
export async function markObservationRead(id: string): Promise<Observation | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM observations WHERE id = ?")
    .get(id) as ObservationRow | undefined;
  if (!row) return undefined;
  const obs = rowToObservation(row);
  if (obs.read_at) return obs; // idempotent
  obs.read_at = Date.now();
  database
    .prepare("UPDATE observations SET read_at = ? WHERE id = ?")
    .run(obs.read_at, id);
  return obs;
}

/**
 * Time window after which an unread HIGH observation stops counting toward
 * the Page A badge. Per Yen 2026-06-14: he doesn't backtrack past a day, so
 * accumulated unreads turn into "壁紙" — the badge becomes noise instead of
 * a signal. Decay makes the count an honest "今天/昨天該注意的事" signal.
 *
 * Observation itself is NOT mutated (read_at stays empty); only the badge
 * filter ignores it. If Yen ever opens Page B he still sees everything.
 */
export const FRESH_HIGH_MS = 24 * 60 * 60 * 1000;

export function isFreshUnreadHigh(o: Observation, now: number = Date.now()): boolean {
  // Patch D+ (2026-06-14) — 排除未來時間戳（w-2026-06-14-003）。
  // 某條路徑把 schedule fire_at 誤寫進 created_at、造成 now - created_at 為負、
  // 衰減邏輯把它們當「永遠新鮮」、變成 badge 上抹不掉的噪音。
  // 在根治那條 wound 之前，這裡先 defensive 排除。
  const age = now - o.created_at;
  return (
    o.importance === "high" && !o.read_at && age >= 0 && age < FRESH_HIGH_MS
  );
}

/** Count of un-read HIGH-importance observations within the freshness window.
 *  Used by Page A badge. */
export async function countUnreadHighImportance(): Promise<number> {
  ensureMigrated();
  const database = getDb();
  const rows = database
    .prepare(
      "SELECT * FROM observations WHERE importance = 'high' AND read_at IS NULL",
    )
    .all() as unknown as ObservationRow[];
  const now = Date.now();
  return rows
    .map(rowToObservation)
    .filter((o) => isFreshUnreadHigh(o, now)).length;
}

/** Test helper — wipe everything. Not exposed in API routes. */
export async function _clearAll(): Promise<void> {
  ensureMigrated();
  getDb().prepare("DELETE FROM observations").run();
}
