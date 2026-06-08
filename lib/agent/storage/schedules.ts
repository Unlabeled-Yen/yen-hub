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
import { type Schedule, newScheduleId } from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "schedules.json");

type ScheduleMap = Record<string, Schedule>;

let mem: ScheduleMap | null = null;

async function load(): Promise<ScheduleMap> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as ScheduleMap;
  } catch {
    mem = {};
  }
  return mem;
}

async function persist(): Promise<void> {
  if (!mem) return;
  await fs.mkdir(DIR, { recursive: true });
  const tmp = FILE + ".tmp-" + Date.now();
  await fs.writeFile(tmp, JSON.stringify(mem, null, 2), "utf8");
  await fs.rename(tmp, FILE);
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
  const map = await load();
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
  map[s.id] = s;
  await persist();
  return s;
}

export async function setEnabled(id: string, enabled: boolean): Promise<Schedule | null> {
  const map = await load();
  const s = map[id];
  if (!s) return null;
  s.enabled = enabled;
  await persist();
  return s;
}

export async function markFired(id: string, when: number): Promise<void> {
  const map = await load();
  const s = map[id];
  if (!s) return;
  s.last_fired_at = when;
  s.fire_count += 1;
  await persist();
}
