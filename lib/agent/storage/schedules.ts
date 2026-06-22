/**
 * Schedule store — JSON overlay at
 * `~/Library/Application Support/com.yen.hub/schedules.json`.
 *
 * Slice 11 — dynamic cron. Each Schedule is an approved schedule_create
 * intent that has been materialised. The scheduler loop (scheduler.ts)
 * polls this store every minute and fires due schedules.
 *
 * Sibling shape to intents.ts / observations.ts so a future SQLite
 * migration applies uniformly.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { persistJson, withStoreLock } from "./atomic-write";
import { type Schedule, newScheduleId } from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "schedules.json");

type ScheduleMap = Record<string, Schedule>;

let mem: ScheduleMap | null = null;

// Always re-read from disk — no forever-cache. Real bug (2026-06-10):
// in Next standalone, API routes and instrumentation.ts bundle SEPARATE
// instances of this module. The scheduler's instance cached the file at
// boot and never saw schedules created later through a route's instance,
// so new schedules silently never fired until app restart. The file is
// tiny and the scheduler polls once a minute; disk reads are free.
async function load(): Promise<ScheduleMap> {
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as ScheduleMap;
  } catch {
    mem = mem ?? {};
  }
  return mem;
}

// Atomic + observable persist of `mem`. Call only inside a withStoreLock(FILE,
// …) section — the scheduler's overlapping/initial ticks can otherwise
// load-mutate-write concurrently and clobber a markFired (the dedupe relies on
// markFired landing).
async function persist(): Promise<void> {
  if (!mem) return;
  await persistJson(FILE, mem);
}

export async function listSchedules(opts?: {
  enabled?: boolean;
}): Promise<Schedule[]> {
  const map = await load();
  let xs = Object.values(map);
  if (opts?.enabled !== undefined) {
    xs = xs.filter((s) => s.enabled === opts.enabled);
  }
  return xs.sort((a, b) => b.created_at - a.created_at);
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const map = await load();
  return map[id] ?? null;
}

export async function createSchedule(input: {
  intent_id: string;
  created_by: string;
  name: string;
  cron_expr: string;
  action_kind: Schedule["action_kind"];
  action_payload: Record<string, unknown>;
  rationale: string;
  one_shot?: boolean;
  not_before?: number;
}): Promise<Schedule> {
  const now = Date.now();
  const s: Schedule = {
    id: newScheduleId(),
    name: input.name,
    cron_expr: input.cron_expr,
    action_kind: input.action_kind,
    action_payload: input.action_payload,
    enabled: true,
    created_at: now,
    created_by: input.created_by,
    source_intent: input.intent_id,
    fire_count: 0,
    rationale: input.rationale,
    one_shot: input.one_shot,
    not_before: input.not_before,
  };
  await withStoreLock(FILE, async () => {
    const map = await load();
    map[s.id] = s;
    await persist();
  });
  return s;
}

export async function setEnabled(id: string, enabled: boolean): Promise<Schedule | null> {
  return withStoreLock(FILE, async () => {
    const map = await load();
    const s = map[id];
    if (!s) return null;
    s.enabled = enabled;
    await persist();
    return s;
  });
}

/** Hard-delete a schedule from the store. Used by the panel's manual
 *  delete (cleanup of spent one-shots / disabled rows). Irreversible —
 *  unlike setEnabled(false), the row is gone, not just dimmed. Returns
 *  true if a row was removed. */
export async function deleteSchedule(id: string): Promise<boolean> {
  return withStoreLock(FILE, async () => {
    const map = await load();
    if (!map[id]) return false;
    delete map[id];
    await persist();
    return true;
  });
}

export async function markFired(id: string, when: number): Promise<void> {
  await withStoreLock(FILE, async () => {
    const map = await load();
    const s = map[id];
    if (!s) return;
    s.last_fired_at = when;
    s.fire_count += 1;
    await persist();
  });
}
