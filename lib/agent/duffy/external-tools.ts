/**
 * Duffy's external-directory read tools.
 *
 * Vault is Yen's writing / state. Real-world progress lives elsewhere:
 *   - ~/Desktop/Yen/Develop/         — code (Yen Hub itself, websites, scripts)
 *   - ~/Desktop/Learning_AI/         — AI learning materials
 *
 * Slice 11.3 consolidation (2026-06-09): the original 4 tools
 * (read_develop_file / list_develop_dir / read_learning_ai_file /
 * list_learning_ai_dir) were collapsed into 2 generic ones — `root`
 * is now an enum argument. Same caps, same path-traversal guard. Trims
 * Duffy's prompt budget and removes the temptation to add a third
 * "external" surface as yet another pair.
 *
 * Hardening: path traversal blocked, file size capped, list depth bounded.
 *
 * Roots are env-configurable:
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

type ExternalRoot = "develop" | "learning_ai";

function rootPath(root: ExternalRoot): string {
  if (root === "develop") {
    return (
      process.env.YEN_DEVELOP_PATH ??
      join(homedir(), "Desktop", "Yen", "Develop")
    );
  }
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
): Promise<
  { ok: true; entries: ListEntry[]; truncated: boolean } | { ok: false; error: string }
> {
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
/*  Two generic tools — root is an arg.                                        */
/* -------------------------------------------------------------------------- */

export const readExternalFile = tool({
  description:
    "Read a file from one of Yen's external code/learning roots: `develop` (~/Desktop/Yen/Develop/, yen-hub source + other projects) or `learning_ai` (~/Desktop/Learning_AI/, Python-master / agent-architect-mental-map / etc.). Capped at 200KB. Use when Yen asks about real-world build state or when a discussion needs grounding in actual source rather than vault .md guesses.",
  inputSchema: z.object({
    root: z
      .enum(["develop", "learning_ai"])
      .describe(
        "Which external root. `develop` for code, `learning_ai` for study material.",
      ),
    path: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Relative path from the chosen root. No leading slash. E.g. `yen-hub/lib/...`.",
      ),
  }),
  execute: async ({ root, path }) => {
    const r = rootPath(root as ExternalRoot);
    const abs = resolveUnder(r, path);
    if (!abs) return { ok: false as const, error: `path escapes ${root} root` };
    const res = await readFileBounded(abs);
    if (!res.ok) return { ok: false as const, error: res.error };
    return {
      ok: true as const,
      root,
      path,
      bytes: res.bytes,
      truncated: res.truncated,
      mtimeMs: res.mtimeMs,
      content: res.content,
    };
  },
});

export const listExternalDir = tool({
  description:
    "List entries under a directory in one of Yen's external roots (`develop` / `learning_ai`). Skips node_modules / .git / target / .next noise. Pass `.` for the root itself. Capped at 200 entries. Use BEFORE read_external_file to find candidate paths.",
  inputSchema: z.object({
    root: z
      .enum(["develop", "learning_ai"])
      .describe("Which external root."),
    path: z
      .string()
      .min(1)
      .max(500)
      .default(".")
      .describe("Relative path. `.` for the root."),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe("Recursion depth. 1 = immediate children only."),
  }),
  execute: async ({ root, path, depth }) => {
    const r = rootPath(root as ExternalRoot);
    const res = await listDirBounded(r, path, depth ?? 1);
    if (!res.ok) return { ok: false as const, error: res.error };
    return {
      ok: true as const,
      root,
      base: path,
      count: res.entries.length,
      truncated: res.truncated,
      entries: res.entries,
    };
  },
});
