/**
 * POST /api/vault/todos/sync
 *
 * Flush the done-store overlay back into vault .md files:
 *   - `- [ ]` checkbox → `- [x]`
 *   - 自然語言 TODO (下次要 / 待辦 / TODO:) → wrap captured text in
 *     `~~ ... ~~` so it visually crosses out in Obsidian without breaking
 *     the marker (next scan still skips it since the overlay key remains
 *     until the file changes enough to no longer match — and once the
 *     line is struck through it's effectively "done" anyway).
 *
 * After a successful write we drop the done entry. Lines we can't locate
 * (file edited, text shifted) stay in the overlay so the user keeps the
 * "hidden" effect — they just don't get flushed.
 *
 * Returns: { written: number, skipped: number, remaining: number }
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { vaultPath, bustCache } from "@/lib/vault/reader";
import { listDone, unmarkDone } from "@/lib/vault/done-store";

export const dynamic = "force-dynamic";

function strikeLine(line: string, capturedText: string): string | null {
  // Order matters: checkbox first (it also contains words that could match
  // the natural-language regex if the marker text appears inside a list).
  const cb = line.match(/^(\s*[-*+]\s+)\[\s\](\s+)(.+)$/);
  if (cb && cb[3].trim() === capturedText.trim()) {
    return `${cb[1]}[x]${cb[2]}${cb[3]}`;
  }
  const nl = line.match(/^(\s*(?:下次要|待辦|TODO)[:：]?\s*)(.+)$/i);
  if (nl && nl[2].trim() === capturedText.trim()) {
    // Don't double-wrap if already struck.
    if (/^~~.*~~$/.test(nl[2].trim())) return null;
    return `${nl[1]}~~${nl[2]}~~`;
  }
  return null;
}

export async function POST() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const root = vaultPath();
    const done = await listDone();

    // Group by file so we write each file at most once.
    const byFile = new Map<string, typeof done>();
    for (const d of done) {
      const arr = byFile.get(d.file) ?? [];
      arr.push(d);
      byFile.set(d.file, arr);
    }

    let written = 0;
    let skipped = 0;

    for (const [rel, entries] of byFile) {
      const abs = join(root, rel);
      let text: string;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        skipped += entries.length;
        continue;
      }
      const lines = text.split("\n");
      let touched = false;

      for (const d of entries) {
        // Search a small window around the recorded line first, then scan
        // the whole file. Cheap and tolerant of small shifts.
        const candidates: number[] = [];
        const lo = Math.max(0, d.lineNum - 6);
        const hi = Math.min(lines.length, d.lineNum + 6);
        for (let i = lo; i < hi; i++) candidates.push(i);
        for (let i = 0; i < lines.length; i++) {
          if (i < lo || i >= hi) candidates.push(i);
        }
        let hit = -1;
        for (const idx of candidates) {
          const next = strikeLine(lines[idx], d.text);
          if (next !== null) {
            lines[idx] = next;
            hit = idx;
            break;
          }
        }
        if (hit >= 0) {
          touched = true;
          await unmarkDone(d.file, d.text);
          written++;
        } else {
          skipped++;
        }
      }

      if (touched) {
        await fs.writeFile(abs, lines.join("\n"), "utf8");
      }
    }

    bustCache("todos:");

    return NextResponse.json({
      written,
      skipped,
      remaining: (await listDone()).length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
