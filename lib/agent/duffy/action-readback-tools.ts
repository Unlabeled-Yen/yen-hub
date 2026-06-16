/**
 * Action read-back (2026-06-16, PRD v2 Gap C) — close the loop on
 * propose_action_task. Duffy files a task fire-and-forget; the local watcher
 * (scripts/action-watcher.mjs) runs it unattended and writes the result to
 * `04 - Action/{completed,rejected}/<id>.md` with a YAML-lite frontmatter
 * (status / exit_code / executed_at / duration_ms) + a `## Output` block.
 *
 * Before this tool Duffy had no way to read that back — it could fire a task
 * but never know how it ended, so "剛那個任務跑完了嗎" was answered by guess.
 * This reads the watcher's own output. Read-only; no execution.
 */

import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { vaultPath } from "@/lib/vault/reader";

const ACTION_REL = "04 - Action";

type ActionState = "pending" | "completed" | "rejected" | "not_found";

/** Parse the watcher's YAML-lite frontmatter (one `key: value` per line). */
function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  const fm: Record<string, string> = {};
  if (!m) return fm;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

function extractOutput(raw: string, cap = 800): string {
  const idx = raw.indexOf("## Output");
  if (idx < 0) return "";
  const after = raw.slice(idx + "## Output".length).trim();
  return after.length > cap ? after.slice(0, cap) + "\n…(truncated)" : after;
}

/** Reject ids that could escape the action dir — id comes from the LLM. */
function safeId(id: string): boolean {
  return !id.includes("/") && !id.includes("\\") && !id.includes("..");
}

async function readOne(root: string, id: string) {
  for (const dir of ["completed", "rejected"] as const) {
    try {
      const raw = await fs.readFile(join(root, dir, `${id}.md`), "utf8");
      const fm = parseFrontmatter(raw);
      return {
        id,
        state: dir as ActionState,
        status: fm.status ?? null, // success | failed | rejected
        exit_code: fm.exit_code ?? null,
        executed_at: fm.executed_at ?? null,
        duration_ms: fm.duration_ms ?? null,
        output_excerpt: extractOutput(raw),
      };
    } catch {
      /* not in this dir — try next */
    }
  }
  try {
    await fs.access(join(root, "pending", `${id}.md`));
    return { id, state: "pending" as ActionState };
  } catch {
    /* not queued either */
  }
  return { id, state: "not_found" as ActionState };
}

export const readActionStatus = tool({
  description:
    "Check what happened to action task(s) you filed via propose_action_task. The watcher runs them unattended and writes results to disk; this reads them back so you answer '剛那個任務跑完了嗎 / 結果如何' with FACTS, not a guess. Pass `id` for one task. Omit `id` to list the most recent finished tasks (survey mode) when Yen asks generally '那些任務怎樣了'. Read-only — no approval.",
  inputSchema: z.object({
    id: z
      .string()
      .optional()
      .describe(
        "Task id returned by propose_action_task. Omit to list recent finished tasks.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Survey mode only (no id): how many recent finished tasks to list."),
  }),
  execute: async ({ id, limit }) => {
    const root = join(vaultPath(), ACTION_REL);

    if (id) {
      if (!safeId(id))
        return { ok: false as const, error: "invalid id" };
      return { ok: true as const, ...(await readOne(root, id)) };
    }

    // Survey mode: newest finished tasks across completed + rejected.
    const out: Array<{
      id: string;
      state: string;
      status: string | null;
      executed_at: string | null;
      mtime: number;
    }> = [];
    for (const dir of ["completed", "rejected"] as const) {
      let files: string[] = [];
      try {
        files = await fs.readdir(join(root, dir));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".md")) continue; // skip .stdout.txt / .stderr.txt sidecars
        const fpath = join(root, dir, f);
        let mtime = 0;
        let fm: Record<string, string> = {};
        try {
          mtime = (await fs.stat(fpath)).mtimeMs;
          fm = parseFrontmatter(await fs.readFile(fpath, "utf8"));
        } catch {
          /* skip unreadable */
        }
        out.push({
          id: f.replace(/\.md$/, ""),
          state: dir,
          status: fm.status ?? null,
          executed_at: fm.executed_at ?? null,
          mtime,
        });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return {
      ok: true as const,
      count: out.length,
      recent: out.slice(0, limit ?? 5).map(({ mtime: _mtime, ...rest }) => rest),
    };
  },
});
