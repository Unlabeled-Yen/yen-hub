/**
 * Done-store — local JSON overlay marking TODOs as "completed" without
 * touching vault .md source. Lives at
 * `~/Library/Application Support/com.yen.hub/done-todos.json`.
 *
 * Key = sha1(file + text)[0..16] — text is included so the entry still matches
 * after lines shift in the source file.
 *
 * The store is the truth for what's hidden from Page A's TODO panel; the
 * vault stays untouched until the user hits "同步到 vault", which writes
 * back as `[x]` / ~~strikethrough~~ and clears the overlay.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "done-todos.json");

export type DoneEntry = {
  key: string;
  file: string;
  lineNum: number;
  text: string;
  doneAt: number;
};

export function todoKey(file: string, text: string): string {
  return createHash("sha1").update(`${file}\n${text}`).digest("hex").slice(0, 16);
}

let mem: Record<string, DoneEntry> | null = null;

async function load(): Promise<Record<string, DoneEntry>> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, DoneEntry>;
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
    /* swallow — overlay write failures shouldn't break the page */
  }
}

export async function loadDoneMap(): Promise<Record<string, DoneEntry>> {
  return await load();
}

export async function listDone(): Promise<DoneEntry[]> {
  const m = await load();
  return Object.values(m).sort((a, b) => b.doneAt - a.doneAt);
}

export async function markDone(
  file: string,
  lineNum: number,
  text: string,
): Promise<void> {
  const m = await load();
  const key = todoKey(file, text);
  m[key] = { key, file, lineNum, text, doneAt: Date.now() };
  await save();
}

export async function unmarkDone(file: string, text: string): Promise<void> {
  const m = await load();
  delete m[todoKey(file, text)];
  await save();
}

export async function clearAllDone(): Promise<void> {
  mem = {};
  await save();
}
