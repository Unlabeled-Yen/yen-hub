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

export async function listObservations(filter?: {
  agent?: string;
  zone?: string;
  since?: number; // epoch ms
}): Promise<Observation[]> {
  const m = await load();
  let items = Object.values(m);
  if (filter?.agent)
    items = items.filter((o) => o.source_agent_id === filter.agent);
  if (filter?.zone) items = items.filter((o) => o.zone === filter.zone);
  if (filter?.since) items = items.filter((o) => o.created_at >= filter.since!);
  return items.sort((a, b) => b.created_at - a.created_at);
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
}): Promise<Observation> {
  const m = await load();
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
  };
  m[obs.id] = obs;
  await save();
  return obs;
}

/**
 * Bump an observation's intention.last_touched_at to now. Used when Yen
 * re-mentions an intention so it stops being "stale". Idempotent.
 */
export async function touchIntention(id: string): Promise<Observation | undefined> {
  const m = await load();
  const obs = m[id];
  if (!obs || !obs.intention) return undefined;
  obs.intention = { ...obs.intention, last_touched_at: Date.now() };
  await save();
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
  const m = await load();
  const obs = m[id];
  if (!obs) return undefined;
  delete m[id];
  await save();
  return obs;
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
  const m = await load();
  const obs = m[id];
  if (!obs) return undefined;
  if (obs.read_at) return obs; // idempotent
  obs.read_at = Date.now();
  await save();
  return obs;
}

/** Count of un-read HIGH-importance observations. Used by Page A badge. */
export async function countUnreadHighImportance(): Promise<number> {
  const m = await load();
  return Object.values(m).filter(
    (o) => o.importance === "high" && !o.read_at,
  ).length;
}

/** Test helper — wipe everything. Not exposed in API routes. */
export async function _clearAll(): Promise<void> {
  mem = {};
  await save();
}
