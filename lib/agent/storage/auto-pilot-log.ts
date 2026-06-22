/**
 * Auto-pilot action log — Slice 12 Phase 4.
 *
 * Append-only JSONL of every tier change auto-pilot makes. Lets the user
 * see what the runner has done (UI surfaces last N actions) and audit
 * past decisions if something feels off.
 *
 * Same on-disk pattern as trust-signals.jsonl — append O(1), read newest-
 * first capped at MAX_READ_LINES, rotate at 5MB.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "auto-pilot-log.jsonl");
const OLD_FILE = FILE + ".old";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_READ_LINES = 200;

export type AutoPilotAction = {
  ts: number;
  kind: string;
  /** Phase 4b — zone for path-bearing kinds ("workspace" | "vault"); omitted
   *  for zoneless kinds. Lets the audit log + cooldown distinguish
   *  file_create@workspace from file_create@vault. */
  zone?: "workspace" | "vault";
  from_tier: "L0" | "L1" | "L2";
  to_tier: "L0" | "L1" | "L2";
  direction: "upgrade" | "downgrade";
  reason: string;
  stats_snapshot: {
    approved: number;
    rejected: number;
    auto_approved: number;
    auto_undone: number;
    total: number;
    approve_rate: number;
    undo_rate: number;
  };
};

async function ensureDir(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const stat = await fs.stat(FILE);
    if (stat.size > MAX_FILE_BYTES) {
      await fs.rename(FILE, OLD_FILE).catch(() => {});
    }
  } catch {
    /* not yet created */
  }
}

export async function appendAutoPilotAction(action: AutoPilotAction): Promise<void> {
  try {
    await ensureDir();
    await rotateIfNeeded();
    await fs.appendFile(FILE, JSON.stringify(action) + "\n", "utf8");
  } catch (e) {
    console.warn("[auto-pilot-log] append failed:", e);
  }
}

export async function readRecentActions(limit: number = 20): Promise<AutoPilotAction[]> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const out: AutoPilotAction[] = [];
  const cap = Math.min(limit, MAX_READ_LINES);
  for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AutoPilotAction);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** When was the most recent action for this kind? Used by the runner's
 *  per-kind cooldown to avoid flapping. */
export async function lastActionForKind(kind: string): Promise<number | null> {
  const all = await readRecentActions(MAX_READ_LINES);
  for (const a of all) {
    if (a.kind === kind) return a.ts;
  }
  return null;
}

/** Phase 4b — most recent action for a (kind, zone) bucket. Zone null matches
 *  zoneless actions (no `zone` field). Drives the per-bucket cooldown so a
 *  workspace promotion doesn't also freeze the vault bucket. */
export async function lastActionForBucket(
  kind: string,
  zone: "workspace" | "vault" | null,
): Promise<number | null> {
  const all = await readRecentActions(MAX_READ_LINES);
  for (const a of all) {
    if (a.kind === kind && (a.zone ?? null) === zone) return a.ts;
  }
  return null;
}
