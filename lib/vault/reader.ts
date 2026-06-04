/**
 * Vault reader — shared helpers for /api/vault/* routes.
 *
 * Reads the Obsidian vault pointed to by YEN_VAULT_PATH. Skips noise dirs.
 * Classifies every file into a Zone bucket whose labels match Yen's own
 * phenomenology (library / septic / workshop / writing / trading / queue /
 * indexes / derived / other) — see `classifyZone` for the mapping rationale.
 *
 * Also reads .obsidian/workspace.json's `lastOpenFiles` so we can tell which
 * files Yen has actually opened recently, vs ones just dumped and forgotten.
 */

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

import { appendAndUnion } from "./reading-log";

const EXCLUDE_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  ".cursor",
  ".claude",
  "node_modules",
]);

export type Zone =
  | "library" // 📚 LLM Wiki/raw/外部資料 — e-books, TBR with intent
  | "septic" //  ⚠️ LLM Wiki/raw/筆記資料 — AI summaries + convo logs
  | "workshop" // 🔧 06 - AI Data/skills + agents — actual AI toolkit (folder renamed 2026-06-02 from "AI Toolkit")
  | "yenhub" //  🏗 06 - AI Data/Yen Hub — the desktop app project itself
  | "agentdata" // 🤖 06 - AI Data/{Observations,Summaries,Silhouettes} — agent-generated content; AttentionGrid filters this out so Duffy doesn't see his own writes
  | "writing" // ✍️ 03 - Main Notes (root)
  | "trading" // 💹 04 - Trading Review — frequency only, until proper log exists
  | "queue" //   📥 05 - Queue — drafts in flight
  | "indexes" //    02 - Indexes + 01 - Tags — rules / MOC / hub edits
  | "derived" //    LLM Wiki/derived — processed but not main
  | "drafts" //     LLM Wiki/raw/寫作草稿 + other raw drafts
  | "other";

const ZONE_LABEL: Record<Zone, string> = {
  library: "📚 圖書館",
  septic: "⚠️ 筆記摘錄",
  workshop: "🔧 AI建造",
  yenhub: "🏗 Yen Hub",
  agentdata: "🤖 Agent 資料",
  writing: "✍️ 寫作",
  trading: "💹 交易複盤",
  queue: "📥 佇列",
  indexes: "🗂 規約 / 索引",
  derived: "🪜 加工筆記",
  drafts: "📝 寫作草稿",
  other: "其他",
};

export function zoneLabel(z: Zone): string {
  return ZONE_LABEL[z];
}

/**
 * If a file is part of a chaptered book (path contains /Chapters/ or /full/),
 * return the book's root directory path. Otherwise null.
 *
 * Examples:
 *   "LLM Wiki/raw/外部資料/Hamming/Chapters/004_02 …" → "LLM Wiki/raw/外部資料/Hamming"
 *   "LLM Wiki/raw/筆記資料/如何讀，為什麼讀/full/001_前言.md" → "…/如何讀，為什麼讀"
 */
export function bookKey(relPath: string): string | null {
  const m = relPath.match(/^(.+?)\/(Chapters|full)\//);
  return m ? m[1] : null;
}

/**
 * Classify a vault-relative path into a Zone. Order matters — structural
 * patterns first (a chaptered book under raw/ is library no matter which
 * subfolder name it lives in), then path-prefix rules.
 */
export function classifyZone(relPath: string): Zone {
  const p = relPath;

  // Structural override — anything chaptered under raw/ is a book.
  if (bookKey(p) && p.startsWith("LLM Wiki 知識庫/raw/")) return "library";

  if (p.startsWith("LLM Wiki 知識庫/raw/外部資料/")) return "library";
  if (p.startsWith("LLM Wiki 知識庫/raw/筆記資料/")) return "septic";
  if (p.startsWith("LLM Wiki 知識庫/raw/寫作草稿/")) return "drafts";
  if (p.startsWith("LLM Wiki 知識庫/raw/")) return "drafts";
  if (p.startsWith("LLM Wiki 知識庫/derived/")) return "derived";
  // Agent-generated content — segregate so Duffy doesn't read his own writes.
  // AttentionGrid filters this zone out.
  if (
    p.startsWith("06 - AI Data/Observations/") ||
    p.startsWith("06 - AI Data/Summaries/") ||
    p.startsWith("06 - AI Data/Silhouettes/")
  )
    return "agentdata";
  // Yen Hub lives inside 06 - AI Data but it's the desktop-app project,
  // not a skill / agent. Check BEFORE the general workshop rule.
  if (p.startsWith("06 - AI Data/Yen Hub/")) return "yenhub";
  if (p.startsWith("06 - AI Data/")) return "workshop";
  if (p.startsWith("05 - Queue/")) return "queue";
  if (p.startsWith("04 - Trading Review/")) return "trading";
  // 03 - Main Notes: only root-level .md is "writing"; subfolders are work-in-progress
  if (p.startsWith("03 - Main Notes/")) {
    const rest = p.slice("03 - Main Notes/".length);
    if (!rest.includes("/")) return "writing";
    return "drafts";
  }
  if (p.startsWith("02 - Indexes/") || p.startsWith("01 - Tags/")) return "indexes";
  return "other";
}

export function vaultPath(): string {
  const p = process.env.YEN_VAULT_PATH;
  if (!p) throw new Error("YEN_VAULT_PATH is not set");
  return p;
}

async function walk(dir: string, out: string[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      await walk(join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(join(dir, e.name));
    }
  }
}

export async function listMarkdown(vault: string): Promise<string[]> {
  const out: string[] = [];
  await walk(vault, out);
  return out;
}

export type FileStat = {
  rel: string; // vault-relative path
  abs: string; // absolute
  mtimeMs: number;
  zone: Zone;
};

export async function statAll(vault: string): Promise<FileStat[]> {
  const abs = await listMarkdown(vault);
  return Promise.all(
    abs.map(async (a) => {
      const s = await fs.stat(a);
      const rel = relative(vault, a);
      return { rel, abs: a, mtimeMs: s.mtimeMs, zone: classifyZone(rel) };
    }),
  );
}

/**
 * Read Obsidian's lastOpenFiles list. Returns the Set of vault-relative
 * paths Yen has touched recently. The list is bounded (~50 items) by
 * Obsidian, so this is "recently opened" not "ever opened".
 */
export async function lastOpenFiles(vault: string): Promise<Set<string>> {
  // Obsidian only retains ~50 paths in workspace.json's lastOpenFiles
  // (zone-blind FIFO). A few days of heavy Queue editing rotates every
  // library chapter, every Trading Review entry, every Indexes file out
  // of the set — silently zeroing AttentionGrid's "opened" count per
  // zone and ReadingProgress's openedChapters per book.
  //
  // Defence is in two layers, applied in order:
  //   1. Read workspace.json AND workspace.json.bak (Obsidian's
  //      auto-backup) — captures one extra generation of rotated entries
  //      from a single source.
  //   2. Union into a Yen-Hub-owned append-only log
  //      (~/Library/Application Support/com.yen.hub/reading-log.json),
  //      then return the log's full contents. Any path Obsidian ever
  //      surfaced — even once, even months ago — stays in the openSet
  //      until the file itself disappears from the vault.
  //
  // The log is zone-blind on purpose: we record what Obsidian saw and let
  // downstream pipelines do their own zone filtering against stats[].
  const dir = join(vault, ".obsidian");
  const fromObsidian = new Set<string>();
  for (const name of ["workspace.json", "workspace.json.bak"]) {
    try {
      const txt = await fs.readFile(join(dir, name), "utf8");
      const json = JSON.parse(txt) as { lastOpenFiles?: string[] };
      for (const f of json.lastOpenFiles ?? []) fromObsidian.add(f);
    } catch {
      /* missing file is fine — silently skip */
    }
  }
  return appendAndUnion(fromObsidian);
}

/** Parse `Tag: [[a]], [[b]]` from the first lines. */
export function parseTagLine(content: string): string[] {
  const head = content.split("\n", 3);
  const tagLine = head.find((l) => l.startsWith("Tag:"));
  if (!tagLine) return [];
  const tags: string[] = [];
  const re = /\[\[([^\]|#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagLine)) !== null) tags.push(m[1].trim());
  return tags;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: unknown }>();

export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function bustCache(prefix: string): void {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}
