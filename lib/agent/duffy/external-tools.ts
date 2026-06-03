/**
 * Duffy's external-directory read tools — Slice 8.10.
 *
 * Vault is Yen's writing / state. Real world progress lives elsewhere:
 *   - ~/Desktop/Yen/Develop/         — code (Yen Hub itself, websites, scripts)
 *   - ~/Desktop/Learning_AI/         — AI learning materials (Python-master,
 *                                       agent-architect-mental-map, etc.)
 *
 * Without read access there, Duffy is stuck inferring from .md files. He
 * said it himself once: "我所有的判斷都建立在 vault 裡的 .md 文字上，而真實
 * 世界的狀態在 Develop/ 裡。" These tools close that gap.
 *
 * Hardening: same shape as vault-tools — path traversal blocked, file size
 * capped, list depth bounded. Read-only.
 *
 * Roots are env-configurable via:
 *   YEN_DEVELOP_PATH       (default: ~/Desktop/Yen/Develop)
 *   YEN_LEARNING_AI_PATH   (default: ~/Desktop/Learning_AI)
 */

import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep, relative } from "node:path";

const MAX_FILE_BYTES = 200_000;
const MAX_LIST_ENTRIES = 200;
const MAX_LIST_DEPTH = 3;

// Skip noisy build / dependency dirs when listing.
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  "target",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".DS_Store",
]);

function developRoot(): string {
  return (
    process.env.YEN_DEVELOP_PATH ??
    join(homedir(), "Desktop", "Yen", "Develop")
  );
}

function learningAiRoot(): string {
  return (
    process.env.YEN_LEARNING_AI_PATH ??
    join(homedir(), "Desktop", "Learning_AI")
  );
}

function resolveUnder(root: string, rel: string): string | null {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

async function readFileBounded(abs: string): Promise<
  | { ok: true; bytes: number; truncated: boolean; content: string; mtimeMs: number }
  | { ok: false; error: string }
> {
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    const buf = await fs.readFile(abs);
    const truncated = buf.length > MAX_FILE_BYTES;
    const content = (
      truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf
    ).toString("utf8");
    return {
      ok: true,
      bytes: stat.size,
      truncated,
      content,
      mtimeMs: stat.mtimeMs,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type ListEntry = {
  path: string;
  type: "file" | "dir";
  bytes?: number;
  mtimeIso?: string;
};

async function listDirBounded(
  root: string,
  startRel: string,
  depth: number,
): Promise<{ ok: true; entries: ListEntry[]; truncated: boolean } | { ok: false; error: string }> {
  const startAbs = resolveUnder(root, startRel);
  if (!startAbs) return { ok: false, error: "path escapes root" };
  const entries: ListEntry[] = [];
  let truncated = false;

  async function walk(abs: string, remaining: number): Promise<void> {
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return;
    }
    let children: string[];
    try {
      children = await fs.readdir(abs);
    } catch {
      return;
    }
    for (const name of children.sort()) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (name.startsWith(".") && name !== ".env.example") continue;
      if (SKIP_DIR_NAMES.has(name)) continue;
      const childAbs = join(abs, name);
      let stat;
      try {
        stat = await fs.stat(childAbs);
      } catch {
        continue;
      }
      const rel = relative(root, childAbs);
      if (stat.isDirectory()) {
        entries.push({
          path: rel,
          type: "dir",
          mtimeIso: new Date(stat.mtimeMs).toISOString(),
        });
        if (remaining > 0) {
          await walk(childAbs, remaining - 1);
        }
      } else if (stat.isFile()) {
        entries.push({
          path: rel,
          type: "file",
          bytes: stat.size,
          mtimeIso: new Date(stat.mtimeMs).toISOString(),
        });
      }
    }
  }

  try {
    const stat = await fs.stat(startAbs);
    if (stat.isFile()) {
      // Allow listing a single file as a degenerate case.
      return {
        ok: true,
        entries: [
          {
            path: startRel,
            type: "file",
            bytes: stat.size,
            mtimeIso: new Date(stat.mtimeMs).toISOString(),
          },
        ],
        truncated: false,
      };
    }
    await walk(startAbs, Math.min(depth, MAX_LIST_DEPTH));
    return { ok: true, entries, truncated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* -------------------------------------------------------------------------- */
/*  Develop                                                                   */
/* -------------------------------------------------------------------------- */

export const readDevelopFile = tool({
  description:
    "Read a file under Yen's Develop directory (~/Desktop/Yen/Develop/, where yen-hub source code + other Yen projects live). Pass a path relative to that root, e.g. `yen-hub/lib/agent/duffy/prompt.ts`. Capped at 200KB. Use when Yen asks about real-world build state, when you need to verify code matches the spec, or when 'why does X work that way' requires looking at actual source.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Relative path from Develop root. No leading slash. E.g. `yen-hub/lib/...`",
      ),
  }),
  execute: async ({ path }) => {
    const abs = resolveUnder(developRoot(), path);
    if (!abs) return { ok: false as const, error: "path escapes Develop root" };
    const r = await readFileBounded(abs);
    if (!r.ok) return { ok: false as const, error: r.error };
    return {
      ok: true as const,
      root: "develop",
      path,
      bytes: r.bytes,
      truncated: r.truncated,
      mtimeMs: r.mtimeMs,
      content: r.content,
    };
  },
});

export const listDevelopDir = tool({
  description:
    "List entries under a directory in Yen's Develop tree (~/Desktop/Yen/Develop/). Skips node_modules / .git / target / .next noise automatically. Pass `.` for the Develop root itself. Capped at 200 entries. Use this BEFORE read_develop_file to find candidate paths.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(500)
      .default(".")
      .describe(
        "Relative path. `.` for the root. E.g. `yen-hub/lib/agent`",
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe("Recursion depth. 1 = immediate children only."),
  }),
  execute: async ({ path, depth }) => {
    const r = await listDirBounded(developRoot(), path, depth ?? 1);
    if (!r.ok) return { ok: false as const, error: r.error };
    return {
      ok: true as const,
      root: "develop",
      base: path,
      count: r.entries.length,
      truncated: r.truncated,
      entries: r.entries,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Learning_AI                                                               */
/* -------------------------------------------------------------------------- */

export const readLearningAiFile = tool({
  description:
    "Read a file under Yen's Learning_AI directory (~/Desktop/Learning_AI/, where his AI learning materials live — Python-master / agent-zero-to-hero / agent-architect-mental-map / etc.). Pass a path relative to that root. Capped at 200KB. Use when Yen asks about something he's been learning, or to ground a discussion in source material rather than guesses.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(500)
      .describe("Relative path from Learning_AI root. No leading slash."),
  }),
  execute: async ({ path }) => {
    const abs = resolveUnder(learningAiRoot(), path);
    if (!abs)
      return { ok: false as const, error: "path escapes Learning_AI root" };
    const r = await readFileBounded(abs);
    if (!r.ok) return { ok: false as const, error: r.error };
    return {
      ok: true as const,
      root: "learning_ai",
      path,
      bytes: r.bytes,
      truncated: r.truncated,
      mtimeMs: r.mtimeMs,
      content: r.content,
    };
  },
});

export const listLearningAiDir = tool({
  description:
    "List entries under a directory in Learning_AI (~/Desktop/Learning_AI/). Same shape as list_develop_dir. Capped at 200 entries.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(500)
      .default(".")
      .describe("Relative path. `.` for root."),
    depth: z.number().int().min(1).max(3).default(1),
  }),
  execute: async ({ path, depth }) => {
    const r = await listDirBounded(learningAiRoot(), path, depth ?? 1);
    if (!r.ok) return { ok: false as const, error: r.error };
    return {
      ok: true as const,
      root: "learning_ai",
      base: path,
      count: r.entries.length,
      truncated: r.truncated,
      entries: r.entries,
    };
  },
});
