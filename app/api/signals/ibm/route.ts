/**
 * GET /api/signals/ibm
 *
 * AI 訊號抓取 MVP — 從 IBM Think hub (https://www.ibm.com/think) 抓
 * "spotlight" 文章卡片。
 *
 * IBM Think 沒有公開 RSS：所有 /think/X/rss.xml、/feed.xml 都 301 回 hub HTML
 * 本身（已實測 2026-06-23）。所以這支 route 走純 HTML 解析，鎖 Adobe AEM
 * 的 `.spotlight__tile` 結構 — 每張卡片是一個 `<a href="...think/insights/X">`
 * 包著 `.spotlight__tile__image` 跟 `.spotlight__tile__content`（含 heading
 * + topic + authors）。
 *
 * 快取：15 分鐘 fresh、stale-while-error 60 分鐘。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hasAnyLLMKey } from "@/lib/ai/model";
import { recordSignals } from "@/lib/agent/storage/signal-history";
import {
  translateCards,
  type TranslationStatus,
} from "@/lib/agent/signals/translate";

export const dynamic = "force-dynamic";

type SignalItem = {
  id: string;
  title: string;
  titleZh: string | null;
  url: string;
  summary: string;
  summaryZh: string | null;
  image: string | null;
  topic: string | null;
  /** LLM-extracted normalized topic tags (set during translation). */
  topics: string[];
  author: string | null;
  publishedAt: string | null;
  source: "ibm-think";
};

type Payload = {
  items: SignalItem[];
  translation: { status: TranslationStatus; note?: string; translated: number };
  fetchedAt: number;
  via: "html" | "stale";
  stale?: boolean;
};

const FRESH_MS = 15 * 60_000;
// 7 days — disk cache stays usable across long gaps between app launches.
// Any visit beyond FRESH_MS hits the SWR path: instant cached render plus
// background refresh that catches up within ~5s.
const STALE_OK_MS = 7 * 24 * 60 * 60_000;
// A forced (?refresh=1) reload re-triggers at most once per this window, so
// the client's stale-poll loop can't spam re-fetches + re-translations.
const FORCE_COOLDOWN_MS = 30_000;
let lastForcedAt = 0;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const HUB_URL = process.env.IBM_THINK_HUB_URL || "https://www.ibm.com/think";

let cache: { payload: Payload; at: number } | null = null;

/**
 * Disk cache — keeps the last successful (Chinese-translated) payload across
 * process restarts so the second-and-later launches show繁中 cards instantly
 * instead of going through the 5s HTML fetch + 4s LLM cycle again.
 * Lives in os.tmpdir() — fine for cache, cleared on reboot.
 */
const DISK_CACHE_PATH = join(tmpdir(), "yen-hub-signals-ibm.json");

function loadDiskCache(): { payload: Payload; at: number } | null {
  try {
    const raw = readFileSync(DISK_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as { payload?: Payload; at?: number };
    if (parsed.payload && typeof parsed.at === "number") {
      return { payload: parsed.payload, at: parsed.at };
    }
  } catch {
    // file missing or corrupt — fine, network fetch will repopulate
  }
  return null;
}

function saveDiskCache(c: { payload: Payload; at: number }) {
  try {
    writeFileSync(DISK_CACHE_PATH, JSON.stringify(c));
  } catch (e) {
    console.warn("[signals/ibm] disk cache write failed:", (e as Error).message);
  }
}

// Seed in-memory cache from disk at module init. May be stale (>15min);
// the GET handler still respects FRESH_MS so a stale disk cache triggers
// a fresh network fetch but the payload is available *immediately* for
// the first request while the network call runs.
cache = loadDiskCache();

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function strip(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Adobe Dynamic Media is picky: the bare URL we scrape from `data-cmp-src`
 * looks like `https://assets.ibm.com/is/image/ibm/<name>?ts=...&dpr=off`,
 * but that exact form returns HTTP 400 ("Error response from backend") —
 * the AEM client-side JS rewrites it before display. Strip the AEM-only
 * query and ask for an explicit format + width, which is what the
 * `dynamicmedia` URL in the page's inline JSON uses.
 */
function normalizeImage(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "assets.ibm.com" && u.pathname.startsWith("/is/image/")) {
      u.search = "";
      u.searchParams.set("fmt", "png-alpha");
      u.searchParams.set("wid", "640");
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

function canonical(url: string): string {
  // Drop tracking query (`?lnk=...`) so URLs collected from multiple slots
  // dedupe down to one card per article.
  try {
    const u = new URL(url, "https://www.ibm.com");
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Walk every <a href=".../think/(insights|news)/<slug>"> on the page.
 *
 * IBM Think homepage uses two AEM templates:
 *   1. `.spotlight__tile` — top "精選" cards. Title in
 *      `.spotlight__tile__content--heading`, topic in `--topic--text`,
 *      author in `--authors`.
 *   2. `<c4d-card>` web component — everything else (carousels, news).
 *      Title in `<c4d-card-heading>`, author in `<c4d-card-eyebrow>`,
 *      summary in the loose `<p>` between heading and `<c4d-card-footer>`.
 *
 * Both shapes embed the image via `data-cmp-src="https://assets.ibm.com/..."`,
 * which we prefer over the inline base64 placeholder `<img srcset>`.
 */
function parseHtmlCards(html: string): SignalItem[] {
  const out: SignalItem[] = [];
  const seen = new Set<string>();
  const anchorRe =
    /<a\b[^>]*\shref=["'](https?:\/\/www\.ibm\.com)?(\/think\/(?:insights|news)\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const pathPart = m[2];
    const url = canonical(`https://www.ibm.com${pathPart}`);
    if (seen.has(url)) continue;

    const inner = m[3];

    // Only count an anchor as a card if it actually carries one of the
    // three known title templates. Image-only anchors (list-container
    // variant: image in one <a>, heading in a sibling <a>) would otherwise
    // burn the URL via dedupe and starve the real card downstream.
    const titleHtml =
      inner.match(
        /class=["'][^"']*spotlight__tile__content--heading[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
      )?.[1] ??
      inner.match(/<c4d-card-heading\b[^>]*>([\s\S]*?)<\/c4d-card-heading>/i)?.[1] ??
      inner.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ??
      null;
    if (!titleHtml) continue;
    const title = strip(titleHtml);
    if (!title || title.length < 4) continue;

    // Topic — spotlight has an explicit chip; c4d cards don't, so we infer
    // from the URL family ("insights" vs "news") to give the UI *something*.
    const topicHtml = inner.match(
      /class=["'][^"']*spotlight__tile__content--topic--text[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    )?.[1];
    const topic = topicHtml
      ? strip(topicHtml) || null
      : pathPart.startsWith("/think/news/")
        ? "News"
        : "Insights";

    const authorHtml =
      inner.match(
        /class=["'][^"']*spotlight__tile__content--authors[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      )?.[1] ??
      inner.match(/<c4d-card-eyebrow\b[^>]*>([\s\S]*?)<\/c4d-card-eyebrow>/i)?.[1] ??
      null;
    const author = authorHtml ? strip(authorHtml) || null : null;

    // Summary — c4d cards stash a loose <p> between the heading and the
    // footer. Spotlight cards have no summary block; we leave it blank.
    let summary = "";
    const c4dSummary = inner.match(
      /<\/c4d-card-heading>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<c4d-card-footer/i,
    );
    if (c4dSummary) summary = strip(c4dSummary[1]).slice(0, 320);

    // Image — prefer the AEM CDN URL on `data-cmp-src`; fall back to a
    // non-data <img src> if a card uses a plain template. Skip base64
    // GIF placeholders that AEM puts on `srcset`.
    const cmpSrc = inner.match(/data-cmp-src=["']([^"']+)["']/i)?.[1];
    let rawImg: string | null = cmpSrc ?? null;
    if (!rawImg) {
      const imgs = inner.matchAll(/<img[^>]+\ssrc=["']([^"']+)["']/gi);
      for (const im of imgs) {
        const s = im[1];
        if (!s.startsWith("data:")) {
          rawImg = s;
          break;
        }
      }
    }
    const image = rawImg ? normalizeImage(decode(rawImg)) : null;

    seen.add(url);
    out.push({
      id: url,
      title,
      titleZh: null,
      url,
      summary,
      summaryZh: null,
      image,
      topic,
      topics: [],
      author,
      publishedAt: null,
      source: "ibm-think",
    });
    if (out.length >= 24) break;
  }
  return out;
}

async function fetchHtml(url: string, timeoutMs = 10_000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Pull a richer summary from each article page's <meta name="description">
 * (the author-written abstract — IBM's hub cards only carry a one-liner or
 * nothing). Runs with bounded concurrency so we don't fire 24 simultaneous
 * requests. Mutates `it.summary` in place when it finds something longer than
 * what we already have. Best-effort: any per-article failure is silently
 * skipped, keeping whatever summary the hub card gave us.
 */
function extractMetaDescription(html: string): string | null {
  // Try name="description" then og:description, with attr order both ways.
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]*\scontent=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*\sname=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]*\scontent=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*\sproperty=["']og:description["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const s = decode(m[1]).trim();
      if (s.length >= 20) return s;
    }
  }
  return null;
}

async function enrichSummaries(items: SignalItem[]): Promise<void> {
  const CONCURRENCY = Number(process.env.SIGNALS_ENRICH_CONCURRENCY) || 6;
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const it = items[idx];
      const html = await fetchHtml(it.url, 9000);
      if (!html) continue;
      const meta = extractMetaDescription(html);
      // Prefer the meta description when it's richer than the hub one-liner.
      if (meta && meta.length > it.summary.length) {
        it.summary = meta.slice(0, 400);
      }
    }
  }
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()),
  );
  const enriched = items.filter((it) => it.summary.length > 0).length;
  console.log(
    `[signals/ibm] enriched ${enriched}/${items.length} summaries in ${Date.now() - t0}ms`,
  );
}

// In-flight translation tracker. We return the English cards immediately
// and let the LLM run in the background; once it finishes, it patches the
// module-level cache so the next client refetch picks up the Chinese.
let translateInFlight: Promise<void> | null = null;
let translationPending = false;
let translateAttempt = 0;
const MAX_TRANSLATE_ATTEMPTS = 4;

function startBackgroundTranslate(raw: SignalItem[]) {
  if (translateInFlight) return;
  translationPending = true;
  translateInFlight = (async () => {
    try {
      // Enrich summaries from each article's meta description BEFORE
      // translating, so the richer English text is what gets sent to the
      // LLM (and what lands in the disk cache). enrichSummaries mutates
      // `raw` in place. Only needs to run once across retries.
      if (translateAttempt === 0) await enrichSummaries(raw);
      if (cache) {
        cache.payload = { ...cache.payload, items: [...raw] };
        saveDiskCache(cache);
      }
      const tr = await translateCards(
        raw,
        (it) => ({ title: it.title, summary: it.summary }),
        (it, t) => ({
          ...it,
          titleZh: t.titleZh,
          summaryZh: t.summaryZh,
          topics: t.topics,
        }),
        "signals/ibm",
      );

      const failed = tr.status !== "ok" && tr.status !== "partial";
      // Self-heal: if the upstream LLM was hanging/erroring, keep the panel
      // in the scanning state (status "pending") and retry shortly, instead
      // of caching an English-only result the client would stop polling.
      if (failed && translateAttempt < MAX_TRANSLATE_ATTEMPTS - 1) {
        translateAttempt++;
        if (cache) {
          cache.payload = {
            ...cache.payload,
            translation: { status: "pending", translated: 0 },
          };
        }
        console.warn(
          `[signals/ibm] translate ${tr.status} — retry ${translateAttempt}/${MAX_TRANSLATE_ATTEMPTS - 1} in 8s`,
        );
        translateInFlight = null;
        translationPending = true;
        setTimeout(() => startBackgroundTranslate(raw), 8000);
        return;
      }

      translateAttempt = 0;
      if (cache) {
        cache.payload = {
          ...cache.payload,
          items: tr.items,
          translation: {
            status: tr.status,
            note: tr.note,
            translated: tr.translated,
          },
        };
        // Persist the translated payload so app restarts see Chinese
        // immediately instead of replaying the LLM round-trip.
        saveDiskCache(cache);
      }
      // Log to history for trend analysis — with titleZh + LLM topics now.
      void recordSignals(
        tr.items.map((it) => ({
          url: it.url,
          title: it.title,
          titleZh: it.titleZh,
          topic: it.topic,
          topics: it.topics,
        })),
      );
    } finally {
      translationPending = false;
      translateInFlight = null;
    }
  })();
}

/**
 * Stale-while-revalidate background refresh — fires when the GET handler
 * returns a stale cache. Pulls fresh HTML + translation, then patches the
 * module + disk cache so the next GET serves the new payload.
 */
let refreshInFlight: Promise<void> | null = null;
function startBackgroundRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = (async () => {
    try {
      const payload = await load();
      cache = { payload, at: Date.now() };
      saveDiskCache(cache);
    } catch (e) {
      console.warn("[signals/ibm] background refresh failed:", (e as Error).message);
    } finally {
      refreshInFlight = null;
    }
  })();
}

async function load(): Promise<Payload> {
  const html = await fetchHtml(HUB_URL);
  if (!html) throw new Error(`fetch ${HUB_URL} failed`);
  const raw = parseHtmlCards(html);
  if (!raw.length) throw new Error("no spotlight cards parsed");

  // Kick off translation in the background and return English cards now.
  // Subsequent GETs hit the cache and will see the Chinese once the
  // background job finishes patching it in.
  if (hasAnyLLMKey()) {
    startBackgroundTranslate(raw);
  } else {
    // No LLM — enrich summaries in the background (English only) and log
    // titles for trend analysis. With a key, startBackgroundTranslate does
    // the enrich + record itself (dedupe by URL means whichever lands first
    // wins).
    void (async () => {
      await enrichSummaries(raw);
      if (cache) {
        cache.payload = { ...cache.payload, items: [...raw] };
        saveDiskCache(cache);
      }
      void recordSignals(
        raw.map((it) => ({
          url: it.url,
          title: it.title,
          titleZh: it.titleZh,
          topic: it.topic,
        })),
      );
    })();
  }

  return {
    items: raw,
    translation: hasAnyLLMKey()
      ? { status: "pending", translated: 0 }
      : { status: "no-key", translated: 0 },
    fetchedAt: Date.now(),
    via: "html",
  };
}

export async function GET(req: Request) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = Date.now();
  // `?refresh=1` (sent on a full page reload, not carousel navigation) forces
  // a re-fetch + re-translate. The client then POLLS the same ?refresh=1 URL
  // while the payload is stale, so a cooldown guard ensures only the first
  // reload actually re-triggers — subsequent polls fall through to the normal
  // cache path (and stop polling once translation completes).
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  if (refresh && cache && now - lastForcedAt > FORCE_COOLDOWN_MS) {
    lastForcedAt = now;
    startBackgroundRefresh();
    return NextResponse.json({ ...cache.payload, stale: true });
  }
  if (cache && now - cache.at < FRESH_MS) {
    return NextResponse.json(cache.payload);
  }
  // Stale-while-revalidate: if we have a cached payload that's older than
  // FRESH_MS but still within STALE_OK_MS, serve it immediately and refresh
  // in the background. This is the path that makes app restart feel instant —
  // disk cache loaded at module init may be hours old, but it still beats
  // a 10-second cold network round-trip.
  if (cache && now - cache.at < STALE_OK_MS) {
    startBackgroundRefresh();
    return NextResponse.json({ ...cache.payload, stale: true });
  }

  try {
    const payload = await load();
    cache = { payload, at: now };
    saveDiskCache(cache);
    return NextResponse.json(payload);
  } catch (err) {
    if (cache && now - cache.at < STALE_OK_MS) {
      return NextResponse.json({ ...cache.payload, stale: true, via: "stale" });
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "fetch failed" },
      { status: 502 },
    );
  }
}
