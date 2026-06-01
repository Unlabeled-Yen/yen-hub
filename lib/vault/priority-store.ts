/**
 * Priority-store — local JSON overlay marking which TODOs the user has
 * promoted to "首要代辦" (priority). Lives at
 * `~/Library/Application Support/com.yen.hub/priority-todos.json`.
 *
 * Mirrors done-store's shape: key = sha1(file + text)[..16], so the
 * same entry stays marked even if the source file's line numbers shift.
 *
 * Priority is a user-curated subset of the active (not-old) TODO pool.
 * Selecting in the Overview tab promotes; clicking again un-promotes.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "priority-todos.json");

export type PriorityEntry = {
  key: string;
  file: string;
  lineNum: number;
  text: string;
  markedAt: number;
};

export function priorityKey(file: string, text: string): string {
  return createHash("sha1").update(`${file}\n${text}`).digest("hex").slice(0, 16);
}

let mem: Record<string, PriorityEntry> | null = null;

async function load(): Promise<Record<string, PriorityEntry>> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as Record<
      string,
      PriorityEntry
    >;
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
    /* swallow — overlay writes are best-effort */
  }
}

export async function loadPriorityMap(): Promise<Record<string, PriorityEntry>> {
  return await load();
}

export async function markPriority(
  file: string,
  lineNum: number,
  text: string,
): Promise<void> {
  const m = await load();
  const k = priorityKey(file, text);
  m[k] = { key: k, file, lineNum, text, markedAt: Date.now() };
  await save();
}

export async function unmarkPriority(
  file: string,
  text: string,
): Promise<void> {
  const m = await load();
  delete m[priorityKey(file, text)];
  await save();
}
