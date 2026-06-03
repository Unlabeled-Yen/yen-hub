/**
 * Duffy's vault-read tools — Slice 7B.
 *
 * Two tools that give Duffy direct access to Yen's vault content (not just
 * metadata). Both are READ-only, hardened against path traversal, and capped
 * to keep prompt budgets sane.
 *
 *   - read_vault_file(path)         single file content
 *   - search_vault(query, limit?)   substring search across all .md files
 *
 * Lives in its own module so the main tools.ts doesn't bloat further.
 */

import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
import { listMarkdown, vaultPath } from "@/lib/vault/reader";

/** Cap on file size we'll feed back to the LLM. 200 KB ≈ 50k chars. */
const MAX_FILE_BYTES = 200_000;
/** Cap on search matches per call. */
const MAX_MATCHES = 25;
/** Snippet width around a match. */
const SNIPPET_BEFORE = 80;
const SNIPPET_AFTER = 160;

/** Resolve a vault-relative path and verify it stays inside the vault. */
function resolveSafe(relPath: string): string {
  const root = vaultPath();
  const abs = resolve(root, relPath);
  if (!(abs === root || abs.startsWith(root + sep))) {
    throw new Error(`path escapes vault: ${relPath}`);
  }
  return abs;
}

/* -------------------------------------------------------------------------- */
/*  read_vault_file                                                           */
/* -------------------------------------------------------------------------- */

export const readVaultFile = tool({
  description:
    "Read a single Markdown file from Yen's vault by relative path (e.g. `03 - Main Notes/某筆記.md`). Returns the file content (capped at 200KB) plus mtime. Use this when you need the actual text of a note — not its existence or metadata. Combine with search_vault to find candidates first.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(500)
      .describe("Vault-relative path. No leading `/`. Must point to a .md file."),
  }),
  execute: async ({ path }) => {
    let abs: string;
    try {
      abs = resolveSafe(path);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } as const;
    }
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        return { ok: false, error: "not a file" } as const;
      }
      const buf = await fs.readFile(abs);
      const truncated = buf.length > MAX_FILE_BYTES;
      const text = (
        truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf
      ).toString("utf8");
      return {
        ok: true,
        path,
        bytes: stat.size,
        truncated,
        mtimeMs: stat.mtimeMs,
        content: text,
      } as const;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } as const;
    }
  },
});

/* -------------------------------------------------------------------------- */
/*  search_vault                                                              */
/* -------------------------------------------------------------------------- */

function takeSnippet(text: string, idx: number, queryLen: number): string {
  const start = Math.max(0, idx - SNIPPET_BEFORE);
  const end = Math.min(text.length, idx + queryLen + SNIPPET_AFTER);
  const pre = start > 0 ? "…" : "";
  const post = end < text.length ? "…" : "";
  return pre + text.slice(start, end).replace(/\s+/g, " ").trim() + post;
}

export const searchVault = tool({
  description:
    "Case-insensitive substring search across every .md file in Yen's vault. Returns up to 25 matches with file path, mtime, and a snippet of context around the match. Use this to find notes mentioning a specific topic before calling read_vault_file on the most relevant one.",
  inputSchema: z.object({
    query: z
      .string()
      .min(2)
      .max(200)
      .describe("Substring to search for. ≥ 2 chars."),
    pathPrefix: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Optional: restrict search to files under this vault-relative prefix (e.g. `04 - Trading Review/`).",
      ),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  execute: async ({ query, pathPrefix, limit }) => {
    const root = vaultPath();
    const needle = query.toLowerCase();
    const cap = Math.min(limit ?? 15, MAX_MATCHES);

    let prefixAbs: string | null = null;
    if (pathPrefix) {
      try {
        prefixAbs = resolveSafe(pathPrefix);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        } as const;
      }
    }

    const files = await listMarkdown(root);
    const matches: Array<{
      path: string;
      mtimeMs: number;
      snippet: string;
    }> = [];

    for (const abs of files) {
      if (prefixAbs && !abs.startsWith(prefixAbs)) continue;
      try {
        const text = await fs.readFile(abs, "utf8");
        const idx = text.toLowerCase().indexOf(needle);
        if (idx < 0) continue;
        const stat = await fs.stat(abs);
        matches.push({
          path: abs.slice(root.length + 1),
          mtimeMs: stat.mtimeMs,
          snippet: takeSnippet(text, idx, needle.length),
        });
        if (matches.length >= cap) break;
      } catch {
        /* unreadable file — skip */
      }
    }

    // Newest first — Yen's most recent thinking usually wins.
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return {
      ok: true,
      query,
      pathPrefix: pathPrefix ?? null,
      scanned: files.length,
      count: matches.length,
      matches,
    } as const;
  },
});
