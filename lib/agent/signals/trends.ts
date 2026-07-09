/**
 * Signal trend analysis — "熱詞 / 趨勢".
 *
 * IBM Think only tags a `topic` chip on its 2–4 "spotlight" cards; the other
 * ~20 cards per fetch carry no topic, so topic-based trends are far too sparse
 * to be useful (a real fetch had 21/24 articles untagged). Instead we mine the
 * article *titles* — the stable English source — for high-frequency terms.
 *
 * Two signals, combined:
 *
 *   1. Frequency — how often a term appears in the recent window. Answers
 *      "what is IBM writing about right now". Works from day one.
 *
 *   2. Z-score — the term's recent daily rate vs. its own N-day baseline:
 *        Z = (recentRate − μ) / σ      over per-day counts
 *      Answers "is this term unusually hot vs. its own history". Dimensionless
 *      and per-term-normalised, so an emerging niche term surfaces even if its
 *      absolute count is small (the standard anomaly-vs-baseline approach from
 *      statistical process control). Needs ≥2 days of data to mean anything;
 *      with one day it's 0 and we fall back to pure frequency ranking.
 *
 * Terms are unigrams + bigrams over the title. Bigrams ("quantum computing")
 * are more meaningful than unigrams, so when a bigram is hot we suppress the
 * unigrams it contains to avoid a strip cluttered with quantum / computing /
 * "quantum computing" all at once.
 */

import { readWindow, type SignalRecord } from "@/lib/agent/storage/signal-history";

const DAY_MS = 24 * 60 * 60_000;

/** English stopwords + IBM-headline filler that carries no topical signal. */
const STOPWORDS = new Set(
  (
    "the a an and or of to in on for with at by from as is are be was were been being " +
    "this that these those it its how why what when where who whom your you we our us they " +
    "their them i me my mine new still yeah right does do did make makes made making every " +
    "all most more less half into out up down over under about after before than then so " +
    "no not yes can could will would should may might must have has had not don't isn't " +
    "via using use used get gets got way ways one two three first next last each via amp " +
    "say says said see sees seen now just like via per vs amp s re ve ll t m d " +
    // IBM brand / filler nouns that aren't topical signal
    "think ibm needs world ways things lot many much really"
  ).split(/\s+/),
);

export type TermTrend = {
  /** The surfaced term (LLM topic tag, or a mined unigram/bigram). */
  term: string;
  kind: "topic" | "unigram" | "bigram";
  /** Total occurrences across the window. */
  count: number;
  /** Occurrences in the recent sub-window. */
  recentCount: number;
  /** Mean daily count across the window (baseline). */
  baseline: number;
  /** Z-score of the recent rate vs. the window baseline. */
  z: number;
  direction: "up" | "flat" | "down";
  /** Which sources surfaced this term — drives the bubble color. */
  source: "ibm" | "github" | "both";
  /** Sample article titles (Chinese if available) containing this term. */
  sampleTitles: string[];
};

export type TrendReport = {
  windowDays: number;
  recentDays: number;
  totalArticles: number;
  daysWithData: number;
  /** "frequency" when <2 days of data (Z meaningless), else "trend". */
  mode: "frequency" | "trend";
  terms: TermTrend[];
  generatedAt: number;
};

function dayKey(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA");
}

/** Tokenise a title into cleaned content words (lowercase, no punctuation,
 *  stopwords + pure-number-noise removed; keeps years like 2026). */
function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter(
      (w) =>
        w.length >= 3 &&
        !STOPWORDS.has(w) &&
        !/^\d+$/.test(w) && // drop ALL pure numbers incl years (2026)
        !/^\d{4}s?$/.test(w), // belt-and-braces: 2026, 1990s
    );
}

type TermAgg = {
  kind: "topic" | "unigram" | "bigram";
  total: number;
  recent: number;
  perDay: Map<string, number>;
  titles: string[];
  /** Sources that contributed this term (for bubble coloring). */
  fromIbm: boolean;
  fromGithub: boolean;
};

/**
 * Compute the term trend report from stored history.
 *
 * @param windowDays  baseline window (default 14)
 * @param recentDays  trailing sub-window treated as "now" (default 3)
 * @param limit       max terms returned (default 10)
 */
export async function computeTopicTrends(
  windowDays = 14,
  recentDays = 3,
  limit = 10,
): Promise<TrendReport> {
  const records = await readWindow(windowDays);
  return analyzeTermTrends(records, windowDays, recentDays, limit);
}

/** Testable core — pure function of the records. */
export function analyzeTermTrends(
  records: SignalRecord[],
  windowDays: number,
  recentDays: number,
  limit: number,
): TrendReport {
  const now = Date.now();
  const recentCutoff = now - recentDays * DAY_MS;

  const dayKeys = new Set<string>();
  for (const r of records) dayKeys.add(dayKey(r.ts));
  const daysWithData = Math.max(1, dayKeys.size);
  const effectiveDays = Math.min(windowDays, daysWithData);

  const byTerm = new Map<string, TermAgg>();

  const bump = (
    term: string,
    kind: "topic" | "unigram" | "bigram",
    rec: SignalRecord,
  ) => {
    let agg = byTerm.get(term);
    if (!agg) {
      agg = {
        kind,
        total: 0,
        recent: 0,
        perDay: new Map(),
        titles: [],
        fromIbm: false,
        fromGithub: false,
      };
      byTerm.set(term, agg);
    }
    agg.total += 1;
    if (rec.ts >= recentCutoff) agg.recent += 1;
    if (rec.source === "github") agg.fromGithub = true;
    else agg.fromIbm = true;
    const k = dayKey(rec.ts);
    agg.perDay.set(k, (agg.perDay.get(k) ?? 0) + 1);
    const display = rec.titleZh ?? rec.title;
    if (agg.titles.length < 3 && !agg.titles.includes(display)) {
      agg.titles.push(display);
    }
  };

  // Prefer LLM topic tags — clean, normalized, semantically meaningful — over
  // mined title tokens. Switch to topic mode once a majority of records carry
  // topics; until then (or with no LLM key) fall back to title token mining.
  const recordsWithTopics = records.filter(
    (r) => (r.topics?.length ?? 0) > 0,
  ).length;
  const topicMode =
    records.length > 0 && recordsWithTopics / records.length >= 0.5;

  for (const r of records) {
    if (topicMode) {
      // One bump per distinct topic tag on this article (normalized to
      // lowercase for case-insensitive aggregation; display keeps the tag).
      const seen = new Set<string>();
      for (const raw of r.topics ?? []) {
        const tag = raw.trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        bump(tag, "topic", r);
      }
      continue;
    }
    // Fallback: title token mining (unigram + bigram).
    const toks = tokenize(r.title);
    const seenUni = new Set<string>();
    for (const w of toks) {
      if (seenUni.has(w)) continue;
      seenUni.add(w);
      bump(w, "unigram", r);
    }
    const seenBi = new Set<string>();
    for (let i = 0; i < toks.length - 1; i++) {
      const bg = `${toks[i]} ${toks[i + 1]}`;
      if (seenBi.has(bg)) continue;
      seenBi.add(bg);
      bump(bg, "bigram", r);
    }
  }

  const mode: TrendReport["mode"] = daysWithData >= 2 ? "trend" : "frequency";

  // Build trend rows, keeping only terms with at least 2 total occurrences
  // (a term seen once is noise, not a trend).
  const rows: TermTrend[] = [];
  for (const [term, agg] of byTerm) {
    if (agg.total < 2) continue;

    const series: number[] = [];
    for (let d = 0; d < effectiveDays; d++) {
      series.push(agg.perDay.get(dayKey(now - d * DAY_MS)) ?? 0);
    }
    const mean = series.reduce((a, b) => a + b, 0) / Math.max(1, series.length);
    const variance =
      series.reduce((a, b) => a + (b - mean) ** 2, 0) /
      Math.max(1, series.length);
    const stdev = Math.sqrt(variance);
    const recentRate =
      agg.recent / Math.max(1, Math.min(recentDays, daysWithData));
    const z = stdev > 0.001 ? (recentRate - mean) / stdev : 0;
    const direction: TermTrend["direction"] =
      recentRate > mean * 1.15 ? "up" : recentRate < mean * 0.85 ? "down" : "flat";

    const source: TermTrend["source"] =
      agg.fromIbm && agg.fromGithub
        ? "both"
        : agg.fromGithub
          ? "github"
          : "ibm";

    rows.push({
      term,
      kind: agg.kind,
      count: agg.total,
      recentCount: agg.recent,
      baseline: Number(mean.toFixed(2)),
      z: Number(z.toFixed(2)),
      direction,
      source,
      sampleTitles: agg.titles,
    });
  }

  // De-redundancy: if a bigram is in the result set, drop the unigrams it's
  // made of (when the unigram isn't substantially more frequent on its own).
  // Keeps "quantum computing" but hides the duplicate quantum / computing.
  const bigramParts = new Set<string>();
  for (const r of rows) {
    if (r.kind === "bigram") {
      const [a, b] = r.term.split(" ");
      bigramParts.add(`${a}|${r.count}`);
      bigramParts.add(`${b}|${r.count}`);
    }
  }
  const kept = rows.filter((r) => {
    if (r.kind !== "unigram") return true;
    // Drop the unigram if some bigram containing it has >= its count.
    for (const r2 of rows) {
      if (r2.kind !== "bigram") continue;
      const [a, b] = r2.term.split(" ");
      if ((a === r.term || b === r.term) && r2.count >= r.count) return false;
    }
    return true;
  });

  // Rank: hot (Z≥1 & up) first by Z, then everyone by recent volume.
  const HOT_Z = 1;
  const hot = (t: TermTrend) => t.z >= HOT_Z && t.direction === "up";
  kept.sort((a, b) => {
    const ah = hot(a),
      bh = hot(b);
    if (ah !== bh) return ah ? -1 : 1;
    if (ah && bh) return b.z - a.z;
    // Prefer bigrams slightly when volume ties — they're more informative.
    return (
      b.recentCount - a.recentCount ||
      (b.kind === "bigram" ? 1 : 0) - (a.kind === "bigram" ? 1 : 0) ||
      b.count - a.count
    );
  });

  return {
    windowDays,
    recentDays,
    totalArticles: records.length,
    daysWithData,
    mode,
    terms: kept.slice(0, limit),
    generatedAt: now,
  };
}
