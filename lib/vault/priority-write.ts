/**
 * Priority-tag writer — Slice 8.8.
 *
 * When Yen toggles a todo as "首要", we mirror that into the vault by
 * appending `#首要` to the matching line in the source markdown. Untoggle
 * strips the tag. This makes the priority state **real** in Obsidian — Yen
 * can search `tag:#首要` natively — instead of only living in our overlay.
 *
 * Matching strategy: search by `text` (not line number) so it survives
 * line drift from unrelated edits. Idempotent in both directions.
 *
 * Failures are non-fatal for the UI flow — the overlay still records the
 * priority. We return { ok, error } so the route handler can log or expose
 * partial state if it wants.
 */

import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { vaultPath } from "./reader";

const TAG = "#首要";
const TAG_RE = /\s*#首要\b/g;

type Result = { ok: boolean; error?: string };

function resolveSafe(rel: string): string | null {
  const root = vaultPath();
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = abs + ".tmp-" + Date.now();
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
}

/** Find the FIRST line that contains `text` (and optionally already has the tag). */
function findLine(
  lines: string[],
  text: string,
  mustHaveTag: boolean,
): number {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(text)) continue;
    if (mustHaveTag && !lines[i].includes(TAG)) continue;
    return i;
  }
  return -1;
}

/** Append `#首要` to the matching line. Idempotent. */
export async function addPriorityTagToVault(
  fileRel: string,
  text: string,
): Promise<Result> {
  const abs = resolveSafe(fileRel);
  if (!abs) return { ok: false, error: "path escapes vault" };
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (e) {
    return { ok: false, error: `read failed: ${(e as Error).message}` };
  }
  // Preserve original newline style — split on \n, write back as joined.
  const lines = content.split("\n");
  const idx = findLine(lines, text, /* mustHaveTag */ false);
  if (idx === -1) return { ok: false, error: "line not found" };
  if (lines[idx].includes(TAG)) return { ok: true }; // already tagged
  lines[idx] = lines[idx].trimEnd() + " " + TAG;
  try {
    await atomicWrite(abs, lines.join("\n"));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `write failed: ${(e as Error).message}` };
  }
}

/** Strip `#首要` from the matching line. Idempotent (no-op if absent). */
export async function removePriorityTagFromVault(
  fileRel: string,
  text: string,
): Promise<Result> {
  const abs = resolveSafe(fileRel);
  if (!abs) return { ok: false, error: "path escapes vault" };
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (e) {
    return { ok: false, error: `read failed: ${(e as Error).message}` };
  }
  const lines = content.split("\n");
  const idx = findLine(lines, text, /* mustHaveTag */ true);
  if (idx === -1) return { ok: true }; // not tagged → nothing to do
  const stripped = lines[idx].replace(TAG_RE, "").trimEnd();
  if (stripped === lines[idx]) return { ok: true };
  lines[idx] = stripped;
  try {
    await atomicWrite(abs, lines.join("\n"));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `write failed: ${(e as Error).message}` };
  }
}
