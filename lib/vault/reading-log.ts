/**
 * Persistent append-only log of file paths ever observed in Obsidian's
 * `workspace.json#lastOpenFiles`. Lives outside the vault at
 * `~/Library/Application Support/com.yen.hub/reading-log.json`.
 *
 * Why
 * ---
 * Obsidian's lastOpenFiles is a FIFO bounded to ~50 entries and is
 * zone-blind: every newly-opened file pushes the oldest out, regardless
 * of where it came from. Yen Hub uses that set to count "opened" files
 * per zone (AttentionGrid hoardRatio) and to derive reading progress per
 * library book. So a few days of heavy Queue editing silently zeroes
 * out the opened count for every other zone — including books Yen
 * actually read in the past.
 *
 * Mitigation: each time we read Obsidian's snapshot we union it into a
 * persistent on-disk log. Subsequent reads return the union, so a file
 * Obsidian saw even once stays in the openSet forever (until the file
 * itself is deleted from the vault, at which point the stats pipeline
 * filters it out naturally).
 *
 * Properties
 * ----------
 *   - Append-only: entries are never removed.
 *   - Zone-blind: stores whatever Obsidian provided; consumers do zone
 *     filtering downstream against `stats[].zone`.
 *   - Atomic writes: temp + rename so a partially-written file can never
 *     corrupt the log (matters for the next read).
 *   - Idempotent: a no-op call where every input is already present
 *     skips the write entirely.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "com.yen.hub",
);
const LOG_FILE = join(LOG_DIR, "reading-log.json");

type Schema = { files: string[] };

async function readLog(): Promise<Set<string>> {
  try {
    const txt = await fs.readFile(LOG_FILE, "utf8");
    const j = JSON.parse(txt) as Schema;
    return new Set(j.files ?? []);
  } catch {
    return new Set();
  }
}

/**
 * Merge the given paths into the persistent log and return the resulting
 * full union. Writes are skipped when no new entries are added so the
 * common case (Obsidian's snapshot identical to last call) costs only
 * one read.
 */
export async function appendAndUnion(
  incoming: Iterable<string>,
): Promise<Set<string>> {
  const current = await readLog();
  let changed = false;
  for (const f of incoming) {
    if (!current.has(f)) {
      current.add(f);
      changed = true;
    }
  }
  if (changed) {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const sorted = Array.from(current).sort();
    const tmp = LOG_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify({ files: sorted }));
    await fs.rename(tmp, LOG_FILE);
  }
  return current;
}
