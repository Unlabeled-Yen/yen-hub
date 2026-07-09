/**
 * Signal history — persistent log of IBM Think article cards, for trend
 * analysis ("本週熱詞").
 *
 * Every time /api/signals/ibm successfully fetches, we record each article
 * (deduped by URL) into an append-only JSONL. The analysis layer reads the
 * trailing 14 days and computes per-topic Z-scores to surface which themes
 * are appearing at an unusual rate right now.
 *
 * Same on-disk pattern as token-usage.jsonl: append O(1), read newest-first,
 * rotate at 10MB. One record per (article, first-seen day) — we dedupe by URL
 * across the whole window so re-fetching the same hub page doesn't double
 * count an article that lingers on the homepage for days.
 *
 * Schema is intentionally minimal: we keep topic + title for analysis, drop
 * image/summary/author (not needed for frequency stats, and keeps the file
 * small over months of accumulation).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "signal-history.jsonl");
const OLD_FILE = FILE + ".old";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_READ_LINES = 20_000;

const DAY_MS = 24 * 60 * 60_000;

export type SignalRecord = {
  /** First time we saw this article (ms epoch). */
  ts: number;
  /** Canonical URL — dedupe key. */
  url: string;
  /** English title (analysis is language-agnostic; English is the stable source). */
  title: string;
  /** Traditional-Chinese title if available, else null. */
  titleZh: string | null;
  /** IBM's own topic label (e.g. "AI ethics"), or inferred "News"/"Insights". */
  topic: string | null;
  /** LLM-extracted normalized topic tags (e.g. ["AI agents","RAG"]). The
   *  primary signal for trend analysis — far cleaner than title token mining.
   *  Optional: absent on records written before topic extraction, or when no
   *  LLM key was available. */
  topics?: string[];
  source: "ibm-think" | "github";
};

async function ensureDir(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const stat = await fs.stat(FILE);
    if (stat.size > MAX_FILE_BYTES) {
      await fs.rename(FILE, OLD_FILE).catch(() => {});
    }
  } catch {
    /* not yet created */
  }
}

async function readRecentRaw(maxLines: number): Promise<SignalRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const out: SignalRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as SignalRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Record a batch of fetched articles. Dedupes by URL against the existing
 * window so an article that sits on the IBM homepage for several days is
 * only logged once (at first sighting). Best-effort — never throws.
 *
 * Returns the count of genuinely-new articles written.
 */
export async function recordSignals(
  items: Array<{
    url: string;
    title: string;
    titleZh: string | null;
    topic: string | null;
    topics?: string[];
    source?: "ibm-think" | "github";
  }>,
  windowDays = 30,
): Promise<number> {
  try {
    if (items.length === 0) return 0;
    const existing = await readRecentRaw(MAX_READ_LINES);
    const cutoff = Date.now() - windowDays * DAY_MS;
    // Track which URLs already have topics — those are fully logged. A URL
    // seen WITHOUT topics is upgradeable: if this batch now carries topics
    // for it, we append an updated record (readWindow dedupes by URL keeping
    // the newest, so the topic'd record wins). This lets articles logged
    // before topic extraction backfill their topics on a later fetch.
    const withTopics = new Set<string>();
    const seenAny = new Set<string>();
    for (const r of existing) {
      if (r.ts < cutoff) continue;
      seenAny.add(r.url);
      if (r.topics && r.topics.length > 0) withTopics.add(r.url);
    }

    const now = Date.now();
    const fresh: SignalRecord[] = [];
    for (const it of items) {
      if (!it.url) continue;
      const hasTopics = (it.topics?.length ?? 0) > 0;
      // Skip if: already fully logged with topics, OR seen and we have no
      // new topics to add.
      if (withTopics.has(it.url)) continue;
      if (seenAny.has(it.url) && !hasTopics) continue;
      seenAny.add(it.url);
      if (hasTopics) withTopics.add(it.url);
      fresh.push({
        ts: now,
        url: it.url,
        title: it.title,
        titleZh: it.titleZh,
        topic: it.topic,
        topics: it.topics ?? [],
        source: it.source ?? "ibm-think",
      });
    }
    if (fresh.length === 0) return 0;

    await ensureDir();
    await rotateIfNeeded();
    await fs.appendFile(
      FILE,
      fresh.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    return fresh.length;
  } catch (e) {
    console.warn("[signal-history] append failed:", e);
    return 0;
  }
}

/**
 * Read all records within the trailing `days` window, deduped by URL.
 *
 * Dedup keeps the NEWEST record per URL — so when an article was logged
 * first without topics and later re-logged with topics (see recordSignals),
 * the topic'd record wins and the analysis sees each article exactly once.
 * `readRecentRaw` returns newest-first, so the first occurrence per URL is
 * the one to keep.
 */
export async function readWindow(days: number): Promise<SignalRecord[]> {
  const recs = await readRecentRaw(MAX_READ_LINES);
  const cutoff = Date.now() - days * DAY_MS;
  const byUrl = new Map<string, SignalRecord>();
  for (const r of recs) {
    if (r.ts < cutoff) continue;
    if (!byUrl.has(r.url)) byUrl.set(r.url, r); // newest-first → first wins
  }
  return [...byUrl.values()];
}
