/**
 * Studio state — the REAL cross-project work-state that feeds the studio face,
 * replacing the vault-mirror panels. For each tracked project it reads:
 *   - git: last commit date, recency (daysCold), recent commit subjects,
 *     uncommitted count   ← deterministic backbone (loud, no LLM)
 *   - the project's checkpoint memory (next-step / landmines Yen wrote)
 *
 * Deterministic on purpose (Yen's rule: deterministic 主軌, LLM 副軌). No LLM
 * here — a later slice can layer synthesis on top. Failures surface in
 * `error`, never silently swallowed.
 *
 * v1: the project list + memory dir are hardcoded personal paths. Fine for a
 * single-user local dashboard; lift to config when it needs to generalize.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MEMORY_DIR =
  "/Users/yen/.claude/projects/-Users-yen-Desktop-ruflo-test/memory";

const PROJECTS: { name: string; path: string }[] = [
  { name: "yen-hub", path: "/Users/yen/Desktop/Yen/Develop/yen-hub" },
  { name: "narcos-oven", path: "/Users/yen/Desktop/Yen/Develop/narcos-oven" },
  { name: "wu-sound-fde", path: "/Users/yen/Desktop/Yen/Develop/wu-sound-fde" },
  {
    name: "meal-prep-planner",
    path: "/Users/yen/Desktop/ruflo-test/develop/meal-prep-planner",
  },
  {
    name: "yen-personal-site",
    path: "/Users/yen/Desktop/Yen/Develop/yen-personal-site",
  },
];

export type ProjectState = {
  name: string;
  path: string;
  lastCommit: string | null; // YYYY-MM-DD
  daysCold: number | null;
  recentCommits: string[];
  uncommitted: number;
  checkpointName: string | null;
  checkpointExcerpt: string | null;
  error: string | null;
};

function git(path: string, args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function stripFrontmatter(md: string): string {
  if (md.startsWith("---")) {
    const end = md.indexOf("\n---", 3);
    if (end !== -1) {
      const after = md.indexOf("\n", end + 1);
      if (after !== -1) return md.slice(after + 1).trim();
    }
  }
  return md.trim();
}

function findCheckpoint(slug: string): { name: string; excerpt: string } | null {
  let files: string[];
  try {
    files = readdirSync(MEMORY_DIR);
  } catch {
    return null;
  }
  const matches = files.filter((f) => f.endsWith(".md") && f.startsWith(slug));
  if (matches.length === 0) return null;
  // Prefer an explicit checkpoint file; then the shortest-named match.
  matches.sort((a, b) => {
    const ac = a.includes("checkpoint") ? 0 : 1;
    const bc = b.includes("checkpoint") ? 0 : 1;
    return ac - bc || a.length - b.length;
  });
  const name = matches[0];
  try {
    const body = stripFrontmatter(readFileSync(join(MEMORY_DIR, name), "utf8"));
    const excerpt =
      body.length > 700 ? body.slice(0, 700).trimEnd() + "…" : body;
    return { name, excerpt };
  } catch {
    return null;
  }
}

/**
 * Resolve a door-knob target to an absolute path — the whitelist that guards
 * the /api/studio/open endpoint. Returns null for anything unknown.
 *   kind='project'    → the project's repo root
 *   kind='checkpoint' → the project's checkpoint memory file, if one exists
 */
export function resolveTarget(
  project: string,
  kind: "project" | "checkpoint",
): string | null {
  const p = PROJECTS.find((x) => x.name === project);
  if (!p) return null;
  if (kind === "project") return p.path;
  const cp = findCheckpoint(p.name);
  return cp ? join(MEMORY_DIR, cp.name) : null;
}

export function readStudioState(): ProjectState[] {
  const now = Date.now();
  const out = PROJECTS.map((p): ProjectState => {
    const base: ProjectState = {
      name: p.name,
      path: p.path,
      lastCommit: null,
      daysCold: null,
      recentCommits: [],
      uncommitted: 0,
      checkpointName: null,
      checkpointExcerpt: null,
      error: null,
    };
    try {
      const lastCommit = git(p.path, [
        "log",
        "-1",
        "--format=%cd",
        "--date=short",
      ]);
      base.lastCommit = lastCommit || null;
      if (lastCommit) {
        const then = new Date(lastCommit + "T00:00:00").getTime();
        base.daysCold = Math.floor((now - then) / 86_400_000);
      }
      base.recentCommits = git(p.path, ["log", "-6", "--format=%s"])
        .split("\n")
        .filter(Boolean);
      const porcelain = git(p.path, ["status", "--porcelain"]);
      base.uncommitted = porcelain
        ? porcelain.split("\n").filter(Boolean).length
        : 0;
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e);
    }
    const cp = findCheckpoint(p.name);
    if (cp) {
      base.checkpointName = cp.name;
      base.checkpointExcerpt = cp.excerpt;
    }
    return base;
  });
  // Freshest first; unknown dates sink to the bottom.
  out.sort((a, b) => {
    if (a.lastCommit && b.lastCommit)
      return a.lastCommit < b.lastCommit ? 1 : -1;
    if (a.lastCommit) return -1;
    if (b.lastCommit) return 1;
    return 0;
  });
  return out;
}
