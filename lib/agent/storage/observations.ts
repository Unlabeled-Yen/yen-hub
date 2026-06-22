/**
 * Observation store — JSON overlay at
 * `~/Library/Application Support/com.yen.hub/observations.json`.
 *
 * Observations are the *result* of an approved observation-intent.
 * They're append-only at Slice 6 (no edit / no delete in API). If Yen wants
 * to retract one, that becomes a follow-up intent in a later slice.
 *
 * Sibling shape to `intents.ts` so the future SQLite migration is uniform.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { persistJson, withStoreLock } from "./atomic-write";
import {
  type EvidenceRef,
  type Importance,
  type IntentionMeta,
  type Observation,
  newObservationId,
} from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "observations.json");

type ObservationMap = Record<string, Observation>;

let mem: ObservationMap | null = null;

// Always re-read from disk — no forever-cache. Real bug (2026-06-10, see
// schedules.ts): in Next standalone, API routes and instrumentation.ts
// bundle SEPARATE instances of this module. Observations are written from
// the cron side (intent-materialize via schedule-actions / summary-cron)
// and read+mutated from routes (undo, mark-high-read). A boot-time cache
// lets each side silently miss the other's writes until restart.
async function load(): Promise<ObservationMap> {
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as ObservationMap;
  } catch {
    mem = mem ?? {};
  }
  return mem;
}

// Raw atomic persist of `mem`; observable on failure. Call only inside a
// withStoreLock(FILE, …) section (relies on the lock to keep `mem` stable).
async function save(): Promise<void> {
  if (!mem) return;
  await persistJson(FILE, mem);
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
  const m = await load();
  let items = Object.values(m);
  if (filter?.agent)
    items = items.filter((o) => o.source_agent_id === filter.agent);
  if (filter?.zone) items = items.filter((o) => o.zone === filter.zone);
  if (filter?.since) items = items.filter((o) => o.created_at >= filter.since!);
  if (!filter?.includeArchived) {
    const now = Date.now();
    items = items.filter((o) => isActive(o, now));
  }
  return items.sort((a, b) => b.created_at - a.created_at);
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
  return withStoreLock(FILE, async () => {
    const m = await load();
    const o = m[oldId];
    if (!o) return undefined;
    if (o.superseded_by) return o; // idempotent
    o.superseded_by = newId;
    o.archived_at = Date.now();
    await save();
    return o;
  });
}

export async function getObservation(
  id: string,
): Promise<Observation | undefined> {
  const m = await load();
  return m[id];
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
  await withStoreLock(FILE, async () => {
    const m = await load();
    m[obs.id] = obs;
    await save();
  });
  return obs;
}

/**
 * Bump an observation's intention.last_touched_at to now. Used when Yen
 * re-mentions an intention so it stops being "stale". Idempotent.
 */
export async function touchIntention(id: string): Promise<Observation | undefined> {
  return withStoreLock(FILE, async () => {
    const m = await load();
    const obs = m[id];
    if (!obs || !obs.intention) return undefined;
    obs.intention = { ...obs.intention, last_touched_at: Date.now() };
    await save();
    return obs;
  });
}

/**
 * Slice 8.7B v2 — delete an observation, used by the undo endpoint when an
 * L0 auto-executed intent is rolled back. Returns the deleted record (or
 * undefined if absent). The Markdown mirror in vault is NOT removed
 * automatically — Yen's vault is sacred ground, we don't reach in. The
 * undo endpoint surfaces this caveat to the caller.
 */
export async function deleteObservation(id: string): Promise<Observation | undefined> {
  return withStoreLock(FILE, async () => {
    const m = await load();
    const obs = m[id];
    if (!obs) return undefined;
    delete m[id];
    await save();
    return obs;
  });
}

/** List observations that carry an open/in_progress intention. */
export async function listIntentionObservations(): Promise<Observation[]> {
  const m = await load();
  return Object.values(m).filter(
    (o) =>
      o.intention &&
      (o.intention.status === "open" || o.intention.status === "in_progress"),
  );
}

/** Mark an observation as read (clears the unread-HIGH badge). */
export async function markObservationRead(id: string): Promise<Observation | undefined> {
  return withStoreLock(FILE, async () => {
    const m = await load();
    const obs = m[id];
    if (!obs) return undefined;
    if (obs.read_at) return obs; // idempotent
    obs.read_at = Date.now();
    await save();
    return obs;
  });
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
  const m = await load();
  const now = Date.now();
  return Object.values(m).filter((o) => isFreshUnreadHigh(o, now)).length;
}

/** Test helper — wipe everything. Not exposed in API routes. */
export async function _clearAll(): Promise<void> {
  mem = {};
  await save();
}
