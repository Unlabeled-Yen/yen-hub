/**
 * GET /api/signals/github
 *
 * GitHub AI-trending tracker. Two lists:
 *   - "rising"  — repos created in the last N days, sorted by stars. These are
 *                 the genuine newcomers (a repo that hit thousands of stars in
 *                 under a month is what "trending" actually means).
 *   - "active"  — all-time most-starred AI repos with a recent push. The
 *                 established giants (ollama, AutoGPT) — steadier, for context.
 *
 * Topics tracked (OR'd into the query): the LLM/agents/rag core plus
 * multimodal and robotics/safety families — configurable via SIGNALS_GH_TOPICS.
 *
 * Auth: GitHub Search API works unauthenticated (10 req/min). Set GITHUB_TOKEN
 * to raise it to 30/min and reduce throttling — we issue only 2 search calls
 * per refresh and cache for 15 min, so unauthenticated is usually fine.
 *
 * Descriptions are translated to Traditional Chinese in the background (same
 * pipeline as IBM), with memory + disk cache and stale-while-revalidate so
 * restarts feel instant.
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
  TITLE_RULE_REPO_NAME,
  type TranslationStatus,
} from "@/lib/agent/signals/translate";

export const dynamic = "force-dynamic";

const FRESH_MS = 15 * 60_000;
const STALE_OK_MS = 7 * 24 * 60 * 60_000;
const FORCE_COOLDOWN_MS = 30_000;
let lastForcedAt = 0;
const RISING_WINDOW_DAYS = 45;

const UA = "yen-hub-signals";

type Repo = {
  id: string;
  fullName: string;
  url: string;
  /** GitHub description (English). */
  title: string;
  titleZh: string | null;
  /** Empty for GitHub — kept for translate-pipeline symmetry. */
  summary: string;
  summaryZh: string | null;
  stars: number;
  /** Approx stars/day since creation — a velocity proxy for the rising list. */
  starsPerDay: number | null;
  language: string | null;
  /** GitHub's own repo topic labels (raw, e.g. "llm", "agent"). */
  topics: string[];
  /** LLM-extracted normalized topic tags (set during translation; same
   *  vocabulary as IBM articles, e.g. "AI agents", "RAG"). Feeds the trend
   *  bubble chart so GitHub and IBM share one topic space. */
  llmTopics: string[];
  owner: string;
  avatar: string;
  createdAt: string;
  pushedAt: string;
};

type Payload = {
  rising: Repo[];
  active: Repo[];
  translation: { status: TranslationStatus; note?: string; translated: number };
  fetchedAt: number;
  stale?: boolean;
};

// Free-text OR keywords across the AI families Yen tracks (LLM/agents/RAG +
// multimodal + robotics/safety). GitHub ANDs `topic:` qualifiers, so we can't
// OR them; free-text OR over name/description/readme naturally unions and
// still returns high-signal repos once filtered by stars + recency.
//
// HARD LIMIT: GitHub search rejects (422) queries with more than 5 boolean
// operators, so we get at most 6 OR'd terms. Pick the highest-signal one per
// family. Quote multi-word phrases so they match as a unit.
const DEFAULT_KEYWORDS =
  'LLM OR "AI agent" OR RAG OR multimodal OR robotics OR "AI safety"';

function keywords(): string {
  return process.env.SIGNALS_GH_KEYWORDS || DEFAULT_KEYWORDS;
}

/* ---------------------------------------------------------------- cache --- */

const DISK_CACHE_PATH = join(tmpdir(), "yen-hub-signals-github.json");
let cache: { payload: Payload; at: number } | null = null;

function loadDiskCache(): { payload: Payload; at: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(DISK_CACHE_PATH, "utf8")) as {
      payload?: Payload;
      at?: number;
    };
    if (parsed.payload && typeof parsed.at === "number") {
      return { payload: parsed.payload, at: parsed.at };
    }
  } catch {
    /* missing/corrupt */
  }
  return null;
}
function saveDiskCache(c: { payload: Payload; at: number }) {
  try {
    writeFileSync(DISK_CACHE_PATH, JSON.stringify(c));
  } catch (e) {
    console.warn("[signals/github] disk cache write failed:", (e as Error).message);
  }
}
cache = loadDiskCache();

/* --------------------------------------------------------------- github --- */

function isoDaysAgo(days: number): string {
  // Pure-arithmetic date — avoid new Date() reliance on wall clock formatting.
  const ms = Date.now() - days * 24 * 60 * 60_000;
  return new Date(ms).toISOString().slice(0, 10);
}

type GhItem = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  topics?: string[];
  owner?: { login: string; avatar_url: string };
  created_at: string;
  pushed_at: string;
};

function toRepo(g: GhItem): Repo {
  const created = Date.parse(g.created_at);
  const ageDays = Number.isFinite(created)
    ? Math.max(1, (Date.now() - created) / (24 * 60 * 60_000))
    : null;
  return {
    id: String(g.id),
    fullName: g.full_name,
    url: g.html_url,
    title: g.description?.trim() || g.full_name,
    titleZh: null,
    summary: "",
    summaryZh: null,
    stars: g.stargazers_count,
    starsPerDay: ageDays ? Math.round(g.stargazers_count / ageDays) : null,
    language: g.language,
    topics: g.topics ?? [],
    llmTopics: [],
    owner: g.owner?.login ?? g.full_name.split("/")[0],
    avatar: g.owner?.avatar_url ?? "",
    createdAt: g.created_at,
    pushedAt: g.pushed_at,
  };
}

async function searchRepos(q: string, perPage: number): Promise<Repo[]> {
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(q) +
    `&sort=stars&order=desc&per_page=${perPage}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": UA,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, { headers, cache: "no-store", signal: ctrl.signal });
    if (!r.ok) {
      throw new Error(`github search ${r.status} ${r.statusText}`);
    }
    const json = (await r.json()) as { items?: GhItem[] };
    return (json.items ?? []).map(toRepo);
  } finally {
    clearTimeout(t);
  }
}

async function fetchLists(): Promise<{ rising: Repo[]; active: Repo[] }> {
  const kw = keywords();
  // Rising: created recently, already starred. Active: any age, recent push.
  const risingQ = `${kw} created:>${isoDaysAgo(RISING_WINDOW_DAYS)} stars:>100`;
  const activeQ = `${kw} pushed:>${isoDaysAgo(14)} stars:>5000`;

  // Two sequential calls (search API is rate-limited; sequential avoids a
  // burst that trips the secondary rate limiter on unauthenticated use).
  const rising = await searchRepos(risingQ, 12);
  const active = await searchRepos(activeQ, 12);
  return { rising, active };
}

/* ------------------------------------------------------ translate (bg) --- */

let translateInFlight: Promise<void> | null = null;
let translateAttempt = 0;
const MAX_TRANSLATE_ATTEMPTS = 4;

function startBackgroundTranslate(rising: Repo[], active: Repo[]) {
  if (translateInFlight || !hasAnyLLMKey()) return;
  translateInFlight = (async () => {
    try {
      const all = [...rising, ...active];
      const tr = await translateCards(
        all,
        (r) => ({ title: r.title, summary: r.summary }),
        (r, t) => ({
          ...r,
          titleZh: t.titleZh,
          summaryZh: t.summaryZh,
          llmTopics: t.topics,
        }),
        "signals/github",
        TITLE_RULE_REPO_NAME,
      );

      const failed = tr.status !== "ok" && tr.status !== "partial";
      // Self-heal on transient LLM failure: keep status "pending" (panel stays
      // scanning, client keeps polling) and retry shortly rather than caching
      // an untranslated result.
      if (failed && translateAttempt < MAX_TRANSLATE_ATTEMPTS - 1) {
        translateAttempt++;
        if (cache) {
          cache.payload = {
            ...cache.payload,
            translation: { status: "pending", translated: 0 },
          };
        }
        console.warn(
          `[signals/github] translate ${tr.status} — retry ${translateAttempt}/${MAX_TRANSLATE_ATTEMPTS - 1} in 8s`,
        );
        translateInFlight = null;
        setTimeout(() => startBackgroundTranslate(rising, active), 8000);
        return;
      }

      translateAttempt = 0;
      // Split the translated array back into the two lists by length.
      const trRising = tr.items.slice(0, rising.length);
      const trActive = tr.items.slice(rising.length);
      if (cache) {
        cache.payload = {
          ...cache.payload,
          rising: trRising,
          active: trActive,
          translation: {
            status: tr.status,
            note: tr.note,
            translated: tr.translated,
          },
        };
        saveDiskCache(cache);
      }
      // Log repos to the shared signal history so the trend bubble chart
      // can aggregate GitHub topics alongside IBM. Dedup is by URL, so a
      // repo trending for several days only logs once.
      void recordSignals(
        tr.items.map((r) => ({
          url: r.url,
          title: r.title,
          titleZh: r.titleZh,
          topic: null,
          topics: r.llmTopics,
          source: "github" as const,
        })),
      );
    } finally {
      translateInFlight = null;
    }
  })();
}

let refreshInFlight: Promise<void> | null = null;
function startBackgroundRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = (async () => {
    try {
      const payload = await load();
      cache = { payload, at: Date.now() };
      saveDiskCache(cache);
    } catch (e) {
      console.warn("[signals/github] bg refresh failed:", (e as Error).message);
    } finally {
      refreshInFlight = null;
    }
  })();
}

async function load(): Promise<Payload> {
  const { rising, active } = await fetchLists();
  if (rising.length === 0 && active.length === 0) {
    throw new Error("github returned no repos");
  }
  startBackgroundTranslate(rising, active);
  return {
    rising,
    active,
    translation: hasAnyLLMKey()
      ? { status: "pending", translated: 0 }
      : { status: "no-key", translated: 0 },
    fetchedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ GET --- */

export async function GET(req: Request) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = Date.now();
  // `?refresh=1` (full page reload) forces a re-fetch + re-translate. Cooldown
  // guard so the client's stale-poll loop on the same URL doesn't re-trigger.
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  if (refresh && cache && now - lastForcedAt > FORCE_COOLDOWN_MS) {
    lastForcedAt = now;
    startBackgroundRefresh();
    return NextResponse.json({ ...cache.payload, stale: true });
  }
  if (cache && now - cache.at < FRESH_MS) {
    return NextResponse.json(cache.payload);
  }
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
      return NextResponse.json({ ...cache.payload, stale: true });
    }
    return NextResponse.json(
      { error: (err as Error).message ?? "github fetch failed" },
      { status: 502 },
    );
  }
}
