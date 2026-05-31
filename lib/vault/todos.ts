/**
 * Scan the vault for unfinished promises — markdown task list checkboxes
 * `- [ ]` and natural-language markers ("下次要", "待辦", "TODO"). Returns
 * the items sorted by file mtime descending, so recent commitments float to
 * the top.
 */

import { promises as fs } from "node:fs";
import { relative } from "node:path";
import {
  classifyZone,
  listMarkdown,
  vaultPath,
  type Zone,
} from "./reader";
import { classifyTodo } from "./classify";

const TODO_PATTERNS: RegExp[] = [
  /^\s*[-*+]\s+\[\s\]\s+(.+)$/, // markdown unchecked checkbox
  /^\s*(?:下次要|待辦)[:：]?\s*(.+)$/, // natural language commitments
  /^\s*TODO[:：]?\s*(.+)$/i, // TODO marker
];

export type Todo = {
  file: string; // relative path
  lineNum: number;
  text: string;
  zone: Zone;
  category: string; // from classify.ts — derived from filename + content
  needsAi: boolean; // true for mixed files that warrant AI subdivision
  mtimeMs: number;
};

/**
 * Scan TODOs limited to a specific zone (or all zones if zone is null).
 * Yen wants only 佇列 (queue) by default — SPEC / ADR / draft TODOs are
 * "work artifacts", not personal commitments.
 */
export async function scanTodos(
  limit = 50,
  zoneFilter: Zone | null = "queue",
): Promise<Todo[]> {
  const root = vaultPath();
  const files = await listMarkdown(root);

  const all: Todo[] = [];
  await Promise.all(
    files.map(async (abs) => {
      const rel = relative(root, abs);
      const zone = classifyZone(rel);
      if (zoneFilter && zone !== zoneFilter) return;

      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        return;
      }
      const text = await fs.readFile(abs, "utf8").catch(() => "");
      if (!text) return;

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let captured: string | null = null;
        for (const re of TODO_PATTERNS) {
          const m = line.match(re);
          if (m) {
            captured = m[1].trim();
            break;
          }
        }
        if (!captured) continue;
        const { category, needsAi } = classifyTodo(rel, captured);
        all.push({
          file: rel,
          lineNum: i + 1,
          text: captured,
          zone,
          category,
          needsAi,
          mtimeMs: stat.mtimeMs,
        });
      }
    }),
  );

  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all.slice(0, limit);
}
