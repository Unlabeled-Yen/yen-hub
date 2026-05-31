/**
 * Translate-book service — wraps the static `BOOK_TRANSLATIONS` map and
 * adds an AI fallback for unknown books.
 *
 * Resolution order:
 *   1. Static map (lib/vault/book-translations.ts) — hand-curated, always wins.
 *   2. Persistent cache (~/Library/Application Support/com.yen.hub/
 *      book-translations.json) — populated by previous AI lookups.
 *   3. Live AI call to Claude Sonnet 4.5 — only when key is configured and
 *      the book isn't in either map. The result is written back to cache.
 *   4. Bare parse `Title (Author)` regex — final fallback if AI is off.
 *
 * Server-side only (uses node:fs + ANTHROPIC_API_KEY).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

import { BOOK_TRANSLATIONS, type BookEntry } from "./book-translations";

const CACHE_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "com.yen.hub",
);
const CACHE_FILE = join(CACHE_DIR, "book-translations.json");

let memoryCache: Record<string, BookEntry> | null = null;

async function loadCache(): Promise<Record<string, BookEntry>> {
  if (memoryCache) return memoryCache;
  try {
    const text = await fs.readFile(CACHE_FILE, "utf8");
    memoryCache = JSON.parse(text) as Record<string, BookEntry>;
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

async function persistCache(): Promise<void> {
  if (!memoryCache) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(memoryCache, null, 2), "utf8");
  } catch {
    /* swallow — translation cache failures shouldn't break the page */
  }
}

async function translateWithClaude(rawName: string): Promise<BookEntry> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const prompt = `Translate this book/folder name into Traditional Chinese title + original author name.

Input may be one of these shapes:
  - "<EnglishTitle> (Author)"
  - "<ChineseTitle> (Author)"
  - "<ChineseTitle>_<Author>"
  - "<EnglishTitle>"
  - "<ChineseTitle>"

Input: "${rawName}"

Reply with ONLY valid JSON, nothing else: {"title":"中文書名","author":"作者名"}
Rules:
- title: Traditional Chinese (繁體中文). If the input is already Traditional Chinese, keep it.
- author: original Roman-alphabet name (e.g., "Nassim Nicholas Taleb"), OR Chinese name if a Chinese author. Empty string if no author info.
- Be concise. No commentary, no markdown fences.`;

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-5"),
    prompt,
    maxOutputTokens: 200,
  });

  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error("no JSON in Claude response");
  const parsed = JSON.parse(jsonMatch[0]) as { title?: string; author?: string };
  if (!parsed.title) throw new Error("Claude response missing title");

  return { title: parsed.title.trim(), author: (parsed.author ?? "").trim() };
}

function bareParse(raw: string): BookEntry {
  const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { title: m[1].trim(), author: m[2].trim() };
  return { title: raw.trim(), author: "" };
}

/**
 * Resolve a raw book directory name to its display form. Never throws —
 * always returns something renderable; AI failures degrade to bareParse.
 */
export async function resolveBook(rawName: string): Promise<BookEntry> {
  // 1. Static map
  const known = BOOK_TRANSLATIONS[rawName];
  if (known) return known;

  // 2. Persistent cache
  const cache = await loadCache();
  if (cache[rawName]) return cache[rawName];

  // 3. AI fallback (only if key is configured)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const translated = await translateWithClaude(rawName);
      cache[rawName] = translated;
      // Persist async; don't block the response.
      void persistCache();
      return translated;
    } catch {
      /* fall through to bareParse */
    }
  }

  // 4. Last resort
  return bareParse(rawName);
}

/** Batch helper — resolve many books in parallel. */
export async function resolveBooks(rawNames: string[]): Promise<Record<string, BookEntry>> {
  const entries = await Promise.all(
    rawNames.map(async (name) => [name, await resolveBook(name)] as const),
  );
  return Object.fromEntries(entries);
}
