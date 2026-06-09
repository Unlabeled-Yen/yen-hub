/**
 * Duffy's shell tools — Slice 方向 2 收尾（2026-06-09）.
 *
 * Six whitelist-preset commands. Read-only by spirit — no propose-approve
 * (same posture as web_search). Each tool wraps ONE command pattern with
 * its arg spec; there's no escape hatch to run arbitrary shell.
 *
 * Hardening:
 *   - No `exec(string)`: every call is `execFile(bin, args[])` so user
 *     input never reaches the shell.
 *   - Path traversal: cwd must be under Yen's known roots (Develop /
 *     Learning_AI / Vault), checked before spawning.
 *   - Output capped at 16KB per stream (stdout + stderr).
 *   - 30s timeout. Kill the child on timeout.
 *
 * If a non-trivial side-effect command is ever needed (npm install,
 * git commit), it MUST go through propose-approve via a new IntentKind,
 * not added here.
 */

import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const TIMEOUT_MS = 30_000;
const MAX_OUT_BYTES = 16 * 1024;

const KNOWN_ROOTS = [
  () => process.env.YEN_DEVELOP_PATH ?? join(homedir(), "Desktop", "Yen", "Develop"),
  () => process.env.YEN_LEARNING_AI_PATH ?? join(homedir(), "Desktop", "Learning_AI"),
  () => process.env.YEN_VAULT_PATH ?? join(homedir(), "Desktop", "Yen", "Yen_Vault"),
];

function resolveCwd(input: string): string | null {
  const abs = resolve(input.startsWith("~/") ? input.replace(/^~/, homedir()) : input);
  for (const r of KNOWN_ROOTS) {
    const root = r();
    if (abs === root || abs.startsWith(root + sep)) return abs;
  }
  return null;
}

type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  truncated: boolean;
  cmd: string;
};

function run(
  bin: string,
  args: string[],
  cwd: string,
): Promise<RunResult> {
  return new Promise((res) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const child = execFile(
      bin,
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUT_BYTES * 2,
        env: process.env,
      },
      (err, stdoutBuf, stderrBuf) => {
        stdout = String(stdoutBuf);
        stderr = String(stderrBuf);
        if (stdout.length > MAX_OUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUT_BYTES) + "\n[…truncated]";
          truncated = true;
        }
        if (stderr.length > MAX_OUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUT_BYTES) + "\n[…truncated]";
          truncated = true;
        }
        res({
          ok: !err,
          stdout,
          stderr,
          exit_code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          truncated,
          cmd: `${bin} ${args.join(" ")}`,
        });
      },
    );
    void child;
  });
}

/* -------------------------------------------------------------------------- */
/*  git tools                                                                  */
/* -------------------------------------------------------------------------- */

export const gitStatus = tool({
  description:
    "Run `git status --porcelain=v1 -b` in one of Yen's known repos. Returns current branch + dirty files. Read-only. Use to check repo state before discussing code.",
  inputSchema: z.object({
    cwd: z
      .string()
      .min(1)
      .describe(
        "Repo path. Must be under Develop/, Learning_AI/, or vault. Tilde and absolute paths OK.",
      ),
  }),
  execute: async ({ cwd }) => {
    const abs = resolveCwd(cwd);
    if (!abs) return { ok: false as const, error: "path outside known roots" };
    return await run("git", ["status", "--porcelain=v1", "-b"], abs);
  },
});

export const gitLog = tool({
  description:
    "Run `git log --oneline -n N` in one of Yen's known repos. Use to see recent commits / what changed when.",
  inputSchema: z.object({
    cwd: z.string().min(1),
    n: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("How many recent commits to show. Default 10, max 50."),
  }),
  execute: async ({ cwd, n }) => {
    const abs = resolveCwd(cwd);
    if (!abs) return { ok: false as const, error: "path outside known roots" };
    return await run("git", ["log", "--oneline", `-n`, String(n ?? 10)], abs);
  },
});

export const gitDiff = tool({
  description:
    "Run `git diff [paths]` in one of Yen's known repos. Returns unstaged diff. Use to see what's been changed but not committed.",
  inputSchema: z.object({
    cwd: z.string().min(1),
    paths: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Optional file/dir filters relative to cwd."),
  }),
  execute: async ({ cwd, paths }) => {
    const abs = resolveCwd(cwd);
    if (!abs) return { ok: false as const, error: "path outside known roots" };
    return await run(
      "git",
      ["diff", "--no-color", ...(paths && paths.length ? ["--", ...paths] : [])],
      abs,
    );
  },
});

/* -------------------------------------------------------------------------- */
/*  filesystem inspector                                                       */
/* -------------------------------------------------------------------------- */

export const lsDir = tool({
  description:
    "Run `ls -la` in one of Yen's known roots. Use when list_external_dir's metadata isn't enough and you need raw file info / permissions.",
  inputSchema: z.object({
    cwd: z.string().min(1),
  }),
  execute: async ({ cwd }) => {
    const abs = resolveCwd(cwd);
    if (!abs) return { ok: false as const, error: "path outside known roots" };
    return await run("ls", ["-la"], abs);
  },
});

/* -------------------------------------------------------------------------- */
/*  Node / TypeScript / test                                                   */
/* -------------------------------------------------------------------------- */

export const tscCheck = tool({
  description:
    "Run `npx tsc --noEmit` in one of Yen's known TypeScript projects (yen-hub, etc.). Returns any type errors. Use to verify a change compiles before claiming it does.",
  inputSchema: z.object({
    cwd: z.string().min(1).describe("Project root with a tsconfig.json."),
  }),
  execute: async ({ cwd }) => {
    const abs = resolveCwd(cwd);
    if (!abs) return { ok: false as const, error: "path outside known roots" };
    return await run("npx", ["--no", "--", "tsc", "--noEmit"], abs);
  },
});

export const npmTest = tool({
  description:
    "Run `npm test` (or a named script) in a known project. Tests are typically side-effect-free at the user-data level; this tool does NOT propose because it's expected to be read-equivalent. If a project's test suite mutates real data, do NOT call this tool — propose a real file_edit instead.",
  inputSchema: z.object({
    cwd: z.string().min(1),
    script: z
      .string()
      .optional()
      .describe("Optional npm script name (default 'test')."),
  }),
  execute: async ({ cwd, script }) => {
    const abs = resolveCwd(cwd);
    if (!abs) return { ok: false as const, error: "path outside known roots" };
    return await run("npm", ["run", script ?? "test", "--silent"], abs);
  },
});
