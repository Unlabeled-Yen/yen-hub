/**
 * Scan the vault Queue for commitments. 2026-06-04 model: each `.md` file
 * in `05 - Queue/` (root OR `首要待辦/`) IS a single TODO — the filename
 * IS the commitment, not the checkbox lines inside. Files in other
 * subfolders are ignored (material storage, not commitments).
 *
 * Returned items are sorted by file mtime descending so the freshest
 * commitments float to the top.
 */

import { promises as fs } from "node:fs";
import { relative } from "node:path";
import {
  listMarkdown,
  vaultPath,
  type Zone,
} from "./reader";
import { classifyTodo } from "./classify";

/** Subfolder under `05 - Queue/` that holds "this is the next thing to
 *  ship" files. Membership is the priority signal — no overlay store. */
export const PRIORITY_SUBFOLDER = "首要待辦";

const QUEUE_DIR = "05 - Queue";

export type Todo = {
  file: string; // vault-relative path
  /** Always 0 for file-as-task model — kept for downstream code that
   *  still uses it in keys / IDs. */
  lineNum: number;
  /** Display text for the item — the filename with `.md` stripped and
   *  trailing date suffix tidied. Falls back to the raw filename. */
  text: string;
  zone: Zone;
  category: string;
  needsAi: boolean;
  mtimeMs: number;
  /** True when the file lives under `05 - Queue/首要待辦/`. The folder
   *  IS the priority overlay — clicking an item in the UI moves its
   *  whole file in/out, so this flag is the only source of truth. */
  isPriority: boolean;
};

/** Strip `.md`, strip a trailing `_YYYY-MM-DD` (or `-YYYY-MM-DD`) date
 *  tag, collapse whitespace. The bare filename usually reads as the
 *  commitment ("寫作品牌策略_誠實診斷與整合"). */
function filenameToText(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  return base
    .replace(/\.md$/, "")
    .replace(/[_-]?\d{4}-\d{2}-\d{2}$/, "")
    .trim();
}

/**
 * Scan TODOs in the Queue.
 *
 * @param limit  maximum entries returned after mtime-desc sort
 * @param zoneFilter  kept for API compatibility; only `"queue"` and `null`
 *   produce file-as-task output. Any other zone yields an empty list
 *   because the model is queue-specific.
 */
export async function scanTodos(
  limit = 200,
  zoneFilter: Zone | null = "queue",
): Promise<Todo[]> {
  if (zoneFilter && zoneFilter !== "queue") return [];

  const root = vaultPath();
  const files = await listMarkdown(root);

  const all: Todo[] = [];
  await Promise.all(
    files.map(async (abs) => {
      const rel = relative(root, abs);
      if (!rel.startsWith(`${QUEUE_DIR}/`)) return;

      // Only Queue root files and Queue/首要待辦/ files qualify. Any
      // other subfolder structure is material, not commitments.
      const parts = rel.split("/");
      let isPriority = false;
      if (parts.length === 2) {
        isPriority = false;
      } else if (
        parts.length === 3 &&
        parts[1] === PRIORITY_SUBFOLDER
      ) {
        isPriority = true;
      } else {
        return;
      }

      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        return;
      }

      const text = filenameToText(rel);
      const { category, needsAi } = classifyTodo(rel, text);
      all.push({
        file: rel,
        lineNum: 0,
        text,
        zone: "queue",
        category,
        needsAi,
        mtimeMs: stat.mtimeMs,
        isPriority,
      });
    }),
  );

  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all.slice(0, limit);
}
