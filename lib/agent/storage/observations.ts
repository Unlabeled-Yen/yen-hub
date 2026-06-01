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
  type Observation,
  newObservationId,
} from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "observations.json");

type ObservationMap = Record<string, Observation>;

let mem: ObservationMap | null = null;

async function load(): Promise<ObservationMap> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as ObservationMap;
  } catch {
    mem = {};
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
  };
  m[obs.id] = obs;
  await save();
  return obs;
}

/** Test helper — wipe everything. Not exposed in API routes. */
export async function _clearAll(): Promise<void> {
  mem = {};
  await save();
}
