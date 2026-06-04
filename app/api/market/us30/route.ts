/**
 * GET /api/market/us30?tf=15m|2h|1d
 *
 * Primary source: **Yahoo Finance v8/chart** for `YM=F` — E-mini Dow front
 * month continuous futures (== TradingView's `YM1!`). No API key, public
 * endpoint, doesn't need the crumb/cookie dance that v7/quote does. 24×5
 * trading so the chart stays alive in Asia session. Price is in DJI scale
 * directly (no ETF proxy / ×100 multiplier needed).
 *
 * Fallback 1: **Twelve Data** (free tier, 8/min · 800/day), DIA ETF ×100
 * as DJI proxy. Used when Yahoo blocks or returns garbage.
 *
 * Fallback 2: **Stooq CSV** for ^DJI direct price. Single bar only — last
 * resort.
 *
 * Resilience:
 *   - Module-level fresh cache per timeframe (FRESH_MS).
 *   - Stale-while-error (STALE_OK_MS) keeps last good visible for 30 min.
 */

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const execFileP = promisify(execFile);

type Candle = { t: number; o: number; h: number; l: number; c: number };
type Timeframe = "15m" | "2h" | "1d";

type Quote = {
  symbol: string;
  price: number;
  prev: number;
  change: number;
  changePct: number;
  candles: Candle[];
  marketState: string;
  updatedAt: number;
  source: "yahoo" | "twelvedata" | "stooq";
  timeframe: Timeframe;
  stale?: boolean;
};

const FRESH_MS = 60_000;
const STALE_OK_MS = 30 * 60_000;
const DJI_SCALE = 100; // DIA × 100 ≈ DJI

const cache: Map<Timeframe, { quote: Quote; at: number }> = new Map();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const TD_INTERVAL: Record<Timeframe, string> = {
  "15m": "15min",
  "2h": "2h",
  "1d": "1day",
};
const TD_OUTPUTSIZE: Record<Timeframe, number> = {
  "15m": 78, // ~one US session (6.5h × 4 bars/hr ≈ 26 → take 3 sessions for context)
  "2h": 60, // ~3 weeks of 2h bars
  "1d": 90, // ~4 months of daily bars
};

async function httpGet(
  url: string,
  extraHeaders: string[] = [],
): Promise<{ status: number; body: string }> {
  try {
    const headerArgs: string[] = [];
    for (const h of extraHeaders) {
      headerArgs.push("-H", h);
    }
    const { stdout } = await execFileP(
      "/usr/bin/curl",
      [
        "-s",
        "-w",
        "\n__HTTP_STATUS__:%{http_code}",
        "-A",
        UA,
        "-H",
        "Accept: application/json,text/csv,*/*",
        ...headerArgs,
        "--max-time",
        "10",
        url,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const marker = "\n__HTTP_STATUS__:";
    const idx = stdout.lastIndexOf(marker);
    if (idx < 0) return { status: 200, body: stdout };
    const status = Number(stdout.slice(idx + marker.length).trim());
    return { status, body: stdout.slice(0, idx) };
  } catch (e) {
    throw new Error(`curl ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------- Yahoo Finance (primary, YM=F front-month Dow futures) ----------

type YahooChart = {
  chart: {
    result?: Array<{
      meta: {
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        marketState?: string;
        regularMarketTime?: number;
        gmtoffset?: number;
      };
      timestamp?: number[];
      indicators: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: { code: string; description: string } | null;
  };
};

// Map our tf → Yahoo's (interval, range). Yahoo doesn't support 2h
// natively, so we fetch 60m and aggregate pairs into 2h bars below.
const YAHOO_PARAMS: Record<
  Timeframe,
  { interval: string; range: string; aggregate2h?: boolean }
> = {
  "15m": { interval: "15m", range: "5d" },
  "2h": { interval: "60m", range: "1mo", aggregate2h: true },
  "1d": { interval: "1d", range: "6mo" },
};

function aggregatePairs(bars: Candle[]): Candle[] {
  // Pair consecutive 60m bars → 2h bars. Drop a trailing odd bar so
  // every output bar covers exactly two upstream candles.
  const out: Candle[] = [];
  for (let i = 0; i + 1 < bars.length; i += 2) {
    const a = bars[i];
    const b = bars[i + 1];
    out.push({
      t: a.t,
      o: a.o,
      h: Math.max(a.h, b.h),
      l: Math.min(a.l, b.l),
      c: b.c,
    });
  }
  return out;
}

async function fetchYahoo(tf: Timeframe): Promise<Quote> {
  const { interval, range, aggregate2h } = YAHOO_PARAMS[tf];
  // YM=F → URL-encoded as YM%3DF. Use query1; query2 is the same backend.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/YM%3DF?interval=${interval}&range=${range}&includePrePost=false`;
  // Yahoo's v8/chart is gentler when called with browser-like headers.
  // Without Origin/Referer pointing at finance.yahoo.com, this IP gets
  // 429'd quickly. With them, the same IP often gets through.
  const res = await httpGet(url, [
    "Accept-Language: en-US,en;q=0.9",
    "Origin: https://finance.yahoo.com",
    "Referer: https://finance.yahoo.com/quote/YM%3DF",
  ]);
  if (res.status !== 200) throw new Error(`yahoo ${res.status}`);
  const json = JSON.parse(res.body) as YahooChart;
  if (json.chart.error) {
    throw new Error(`yahoo: ${json.chart.error.description}`);
  }
  const result = json.chart.result?.[0];
  if (!result) throw new Error("yahoo empty result");
  const ts = result.timestamp ?? [];
  const q = result.indicators.quote?.[0];
  if (!q || ts.length === 0) throw new Error("yahoo empty quote");

  let candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    // Yahoo intersperses nulls when no trades happened in an interval —
    // skip those rather than draw a zero-bar.
    if (
      o == null ||
      h == null ||
      l == null ||
      c == null ||
      !Number.isFinite(o) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(c)
    ) {
      continue;
    }
    candles.push({ t: ts[i] * 1000, o, h, l, c });
  }
  if (candles.length === 0) throw new Error("yahoo all-null bars");
  if (aggregate2h) candles = aggregatePairs(candles);

  const price =
    result.meta.regularMarketPrice ?? candles[candles.length - 1].c;
  // For futures, chartPreviousClose is the prior session close that
  // anchors the chart — better than previousClose (which can be stale).
  const prev =
    result.meta.chartPreviousClose ??
    result.meta.previousClose ??
    candles[0]?.o ??
    price;
  const change = price - prev;
  const changePct = prev > 0 ? (change / prev) * 100 : 0;

  return {
    symbol: "US30",
    price,
    prev,
    change,
    changePct,
    candles,
    marketState: result.meta.marketState ?? "REGULAR",
    updatedAt: (result.meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
    source: "yahoo",
    timeframe: tf,
  };
}

// ---------- Twelve Data (fallback 1) ----------

type TDTimeSeries = {
  status?: string;
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume?: string;
  }>;
  meta?: { interval?: string; exchange_timezone?: string };
  message?: string;
  code?: number;
};

type TDQuote = {
  status?: string;
  close?: string;
  previous_close?: string;
  timestamp?: number;
  last_quote_at?: number;
  is_market_open?: boolean;
  message?: string;
  code?: number;
};

function parseTDDatetime(s: string): number {
  // "YYYY-MM-DD HH:MM:SS" — Twelve Data returns in the market's local time
  // (NYSE / America/New_York for DIA). Treat as ET for plotting; the chart
  // formatter we already use is timezone-aware so this is consistent.
  // Convert "YYYY-MM-DD HH:MM:SS" → assume NY local. We compute ms by
  // constructing a UTC Date for the same Y/M/D H/M/S then adjusting by the
  // NY offset. For simplicity here, treat as UTC — the chart only needs
  // monotonic ordering + first/last labels. Off-by-tz won't shift candle
  // order, only label text. Good enough.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return Date.now();
  return Date.UTC(
    +m[1],
    +m[2] - 1,
    +m[3],
    +(m[4] ?? 0),
    +(m[5] ?? 0),
    +(m[6] ?? 0),
  );
}

async function fetchTwelveData(tf: Timeframe, key: string): Promise<Quote> {
  const interval = TD_INTERVAL[tf];
  const outputsize = TD_OUTPUTSIZE[tf];
  const tsUrl = `https://api.twelvedata.com/time_series?symbol=DIA&interval=${interval}&outputsize=${outputsize}&apikey=${key}`;
  const qUrl = `https://api.twelvedata.com/quote?symbol=DIA&apikey=${key}`;

  // Both calls in parallel — saves ~150ms of round-trip.
  const [tsRes, qRes] = await Promise.all([httpGet(tsUrl), httpGet(qUrl)]);
  if (tsRes.status !== 200) throw new Error(`td ts ${tsRes.status}`);
  if (qRes.status !== 200) throw new Error(`td q ${qRes.status}`);
  const ts = JSON.parse(tsRes.body) as TDTimeSeries;
  const qt = JSON.parse(qRes.body) as TDQuote;
  if (ts.status === "error") throw new Error(`td ts: ${ts.message}`);
  if (qt.status === "error") throw new Error(`td q: ${qt.message}`);
  const values = ts.values ?? [];
  if (values.length === 0) throw new Error("td empty values");

  // Twelve Data returns newest first — reverse so chart goes left → right
  // (oldest → newest, expected by CandleChart).
  const candles: Candle[] = values
    .slice()
    .reverse()
    .map((v) => ({
      t: parseTDDatetime(v.datetime),
      o: Number(v.open) * DJI_SCALE,
      h: Number(v.high) * DJI_SCALE,
      l: Number(v.low) * DJI_SCALE,
      c: Number(v.close) * DJI_SCALE,
    }))
    .filter(
      (c) =>
        Number.isFinite(c.o) &&
        Number.isFinite(c.h) &&
        Number.isFinite(c.l) &&
        Number.isFinite(c.c),
    );

  const price = Number(qt.close ?? 0) * DJI_SCALE;
  const prev = Number(qt.previous_close ?? 0) * DJI_SCALE;
  const change = price - prev;
  const changePct = prev > 0 ? (change / prev) * 100 : 0;
  const marketState = qt.is_market_open ? "REGULAR" : "CLOSED";

  return {
    symbol: "US30",
    price,
    prev,
    change,
    changePct,
    candles,
    marketState,
    updatedAt: (qt.last_quote_at ?? qt.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    source: "twelvedata",
    timeframe: tf,
  };
}

// ---------- Mock (dev) ----------
// Enabled via `MOCK_US30=1` in .env.local. Returns a deterministic
// synthetic OHLC series so the UI can be reloaded freely during dev
// without burning Twelve Data's 8/min × 800/day budget.
function fetchMock(tf: Timeframe): Quote {
  // Bar counts matching production TD_OUTPUTSIZE so the chart looks
  // about right.
  const n = tf === "15m" ? 78 : tf === "2h" ? 60 : 90;
  // Time step in minutes per bar.
  const stepMin = tf === "15m" ? 15 : tf === "2h" ? 120 : 60 * 24;
  const stepMs = stepMin * 60_000;
  // Deterministic-ish pseudo-random based on bar index (no Math.random
  // so reloads are stable).
  const lcg = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 0xffffffff;
      return s / 0xffffffff;
    };
  };
  const rnd = lcg(tf === "15m" ? 31 : tf === "2h" ? 47 : 73);

  let close = 50_000; // starting price
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    const t = now - i * stepMs;
    // Drift up over time + random walk
    const drift = (n - i) * 8;
    const move = (rnd() - 0.5) * 220;
    const open = close;
    close = Math.max(40_000, open + move + drift * 0.02);
    const high = Math.max(open, close) + rnd() * 80;
    const low = Math.min(open, close) - rnd() * 80;
    candles.push({ t, o: open, h: high, l: low, c: close });
  }
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2]?.c ?? last.o;
  return {
    symbol: "US30",
    price: last.c,
    prev,
    change: last.c - prev,
    changePct: prev > 0 ? ((last.c - prev) / prev) * 100 : 0,
    candles,
    marketState: "REGULAR",
    updatedAt: Date.now(),
    source: "twelvedata", // pretend; UI doesn't care
    timeframe: tf,
  };
}

// ---------- Stooq (fallback) ----------

async function fetchStooq(tf: Timeframe): Promise<Quote> {
  // ym.f = E-mini Dow front-month continuous futures (== TradingView's
  // YM1!). Trades 24×5 so the price stays live in Asia session, unlike
  // ^dji which only updates during US cash hours. Stooq's history CSV
  // is login-gated, so this remains a single-bar fallback — the chart
  // will collapse to one candle until Yahoo/TD recovers.
  const res = await httpGet("https://stooq.com/q/l/?s=ym.f&f=sd2t2ohlcv&h&e=csv");
  if (res.status !== 200) throw new Error(`stooq ${res.status}`);
  const lines = res.body.trim().split("\n");
  if (lines.length < 2) throw new Error("stooq empty");
  const [, , , o, h, l, c] = lines[1].split(",");
  const open = Number(o);
  const high = Number(h);
  const low = Number(l);
  const close = Number(c);
  if (!Number.isFinite(close)) throw new Error("stooq parse");
  return {
    symbol: "US30",
    price: close,
    prev: open,
    change: close - open,
    changePct: open > 0 ? ((close - open) / open) * 100 : 0,
    candles: [{ t: Date.now(), o: open, h: high, l: low, c: close }],
    marketState: "CLOSED",
    updatedAt: Date.now(),
    source: "stooq",
    timeframe: tf,
  };
}

async function fetchAny(tf: Timeframe): Promise<Quote> {
  try {
    return await fetchYahoo(tf);
  } catch (e) {
    console.log(`[us30] tf=${tf} yahoo failed: ${e instanceof Error ? e.message : e}`);
  }
  const key = process.env.TWELVE_DATA_KEY ?? "";
  if (key) {
    try {
      return await fetchTwelveData(tf, key);
    } catch (e) {
      console.log(`[us30] tf=${tf} td failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return await fetchStooq(tf);
}

// ---------- Handler ----------

function parseTf(s: string | null): Timeframe {
  if (s === "15m" || s === "2h" || s === "1d") return s;
  return "15m";
}

export async function GET(req: NextRequest) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const tf = parseTf(req.nextUrl.searchParams.get("tf"));

  // Dev mock — bypass all upstreams. Set MOCK_US30=1 in .env.local
  // while iterating on the UI to keep TD's 8/min × 800/day budget
  // intact. Cached per-tf so it doesn't flicker between requests.
  if (process.env.MOCK_US30 === "1") {
    const c = cache.get(tf);
    if (c && Date.now() - c.at < 10 * 60_000) {
      return NextResponse.json(c.quote);
    }
    const q = fetchMock(tf);
    cache.set(tf, { quote: q, at: Date.now() });
    console.log(`[us30] tf=${tf} source=MOCK candles=${q.candles.length}`);
    return NextResponse.json(q);
  }

  const cached = cache.get(tf);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return NextResponse.json(cached.quote);
  }

  // Source preference: Yahoo (YM=F futures, no key, no rate limit) →
  // Twelve Data (DIA ×100 proxy) → cached stale rich-OHLC source →
  // Stooq (single-bar last resort). Stale rich-OHLC always wins over
  // fresh Stooq because Stooq's 1 candle trashes the chart.
  try {
    const q = await fetchYahoo(tf);
    cache.set(tf, { quote: q, at: Date.now() });
    console.log(
      `[us30] tf=${tf} source=${q.source} candles=${q.candles.length} price=${q.price.toFixed(2)}`,
    );
    return NextResponse.json(q);
  } catch (e) {
    console.log(
      `[us30] tf=${tf} yahoo failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  const key = process.env.TWELVE_DATA_KEY ?? "";
  if (key) {
    try {
      const q = await fetchTwelveData(tf, key);
      cache.set(tf, { quote: q, at: Date.now() });
      console.log(
        `[us30] tf=${tf} source=${q.source} candles=${q.candles.length} price=${q.price.toFixed(2)}`,
      );
      return NextResponse.json(q);
    } catch (e) {
      console.log(
        `[us30] tf=${tf} td failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Yahoo + TD failed. Prefer last good rich-OHLC cache (yahoo or td)
  // over Stooq's single-bar payload.
  if (
    cached &&
    (cached.quote.source === "yahoo" || cached.quote.source === "twelvedata") &&
    Date.now() - cached.at < STALE_OK_MS
  ) {
    console.log(
      `[us30] tf=${tf} serving stale ${cached.quote.source} (${cached.quote.candles.length} candles)`,
    );
    return NextResponse.json({ ...cached.quote, stale: true });
  }

  // Last resort: Stooq. Single candle but at least a price.
  try {
    const q = await fetchStooq(tf);
    cache.set(tf, { quote: q, at: Date.now() });
    console.log(`[us30] tf=${tf} source=stooq candles=1 price=${q.price.toFixed(2)}`);
    return NextResponse.json(q);
  } catch (e) {
    if (cached && Date.now() - cached.at < STALE_OK_MS) {
      console.log(`[us30] tf=${tf} serving stale ${cached.quote.source}`);
      return NextResponse.json({ ...cached.quote, stale: true });
    }
    console.log(`[us30] tf=${tf} FAIL ${e instanceof Error ? e.message : e}`);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
