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
  newIntentId,
} from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "intents.json");

type IntentMap = Record<string, Intent>;

let mem: IntentMap | null = null;

async function load(): Promise<IntentMap> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as IntentMap;
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
  };
  m[intent.id] = intent;
  await save();
  return intent;
}

export async function decideIntent(
  id: string,
  status: Extract<IntentStatus, "approved" | "rejected">,
  resulted_in?: string,
): Promise<Intent | undefined> {
  const m = await load();
  const intent = m[id];
  if (!intent) return undefined;
  if (intent.status !== "pending") return intent; // idempotent — don't re-decide
  intent.status = status;
  intent.decided_at = Date.now();
  intent.decided_by = "user";
  if (resulted_in) intent.resulted_in = resulted_in;
  await save();
  return intent;
}

/** Test helper — wipe everything. Not exposed in API routes. */
export async function _clearAll(): Promise<void> {
  mem = {};
  await save();
}
