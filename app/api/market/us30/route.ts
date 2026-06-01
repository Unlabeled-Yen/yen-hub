/**
 * GET /api/market/us30?tf=5m|1h|1d
 *
 * Returns OHLC candles + summary for ^DJI (Dow / US30 underlier).
 *
 * Timeframes:
 *   5m → 5-minute candles over the current trading day  (~78 bars)
 *   1h → 1-hour candles over the past 5 sessions         (~33 bars)
 *   1d → daily candles over the past 3 months            (~65 bars)
 *
 * Source resolution:
 *   Primary  → Yahoo (query1 → query2) gives full OHLC time series.
 *   Fallback → Stooq CSV; only one bar's worth (today's OHLC) — chart
 *              degrades gracefully to a single candle.
 *
 * Resilience layers (per timeframe):
 *   - Module-level fresh cache (FRESH_MS) keyed by timeframe.
 *   - Stale-while-error (STALE_OK_MS) — last good kept for 30 min.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Candle = { t: number; o: number; h: number; l: number; c: number };

type Quote = {
  symbol: string;
  price: number;
  prev: number;
  change: number;
  changePct: number;
  candles: Candle[];
  marketState: string;
  updatedAt: number;
  source: "yahoo" | "stooq";
  timeframe: Timeframe;
  stale?: boolean;
};

type Timeframe = "5m" | "1h" | "1d";

const FRESH_MS = 60_000;
const STALE_OK_MS = 30 * 60_000;

const cache: Map<Timeframe, { quote: Quote; at: number }> = new Map();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// ---------- Yahoo ----------

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];

const YAHOO_PARAMS: Record<Timeframe, { interval: string; range: string }> = {
  "5m": { interval: "5m", range: "1d" },
  "1h": { interval: "1h", range: "5d" },
  "1d": { interval: "1d", range: "3mo" },
};

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
        marketState?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

async function fetchYahooHost(host: string, tf: Timeframe): Promise<Quote> {
  const { interval, range } = YAHOO_PARAMS[tf];
  const url = `${host}/v8/finance/chart/%5EDJI?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${host} ${res.status}`);
  const json = (await res.json()) as YahooChart;
  const result = json.chart?.result?.[0];
  if (!result?.meta) {
    throw new Error(json.chart?.error?.description ?? "no result");
  }
  const meta = result.meta;
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const opens = q.open ?? [];
  const highs = q.high ?? [];
  const lows = q.low ?? [];
  const closes = q.close ?? [];

  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (
      typeof o === "number" &&
      typeof h === "number" &&
      typeof l === "number" &&
      typeof c === "number"
    ) {
      candles.push({ t: ts[i] * 1000, o, h, l, c });
    }
  }

  const price = Number(
    meta.regularMarketPrice ?? candles.at(-1)?.c ?? 0,
  );
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? price);
  const change = price - prev;
  const changePct = prev > 0 ? (change / prev) * 100 : 0;
  return {
    symbol: "US30",
    price,
    prev,
    change,
    changePct,
    candles,
    marketState: meta.marketState ?? "CLOSED",
    updatedAt:
      (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
    source: "yahoo",
    timeframe: tf,
  };
}

async function fetchYahoo(tf: Timeframe): Promise<Quote> {
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      return await fetchYahooHost(host, tf);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all yahoo hosts failed");
}

// ---------- Stooq ----------

async function fetchStooq(tf: Timeframe): Promise<Quote> {
  const res = await fetch(
    "https://stooq.com/q/l/?s=^dji&f=sd2t2ohlcv&h&e=csv",
    {
      headers: { "User-Agent": UA },
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
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
  } catch (yahooErr) {
    try {
      return await fetchStooq(tf);
    } catch (stooqErr) {
      throw new Error(
        `yahoo: ${yahooErr instanceof Error ? yahooErr.message : yahooErr}; stooq: ${stooqErr instanceof Error ? stooqErr.message : stooqErr}`,
      );
    }
  }
}

// ---------- Handler ----------

function parseTf(s: string | null): Timeframe {
  if (s === "5m" || s === "1h" || s === "1d") return s;
  return "5m";
}

export async function GET(req: NextRequest) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const tf = parseTf(req.nextUrl.searchParams.get("tf"));

  const cached = cache.get(tf);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return NextResponse.json(cached.quote);
  }

  try {
    const q = await fetchAny(tf);
    cache.set(tf, { quote: q, at: Date.now() });
    console.log(
      `[us30] tf=${tf} source=${q.source} candles=${q.candles.length} price=${q.price}`,
    );
    return NextResponse.json(q);
  } catch (e) {
    if (cached && Date.now() - cached.at < STALE_OK_MS) {
      console.log(`[us30] tf=${tf} serving stale ${cached.quote.source}`);
      return NextResponse.json({ ...cached.quote, stale: true });
    }
    console.log(
      `[us30] tf=${tf} FAIL ${e instanceof Error ? e.message : e}`,
    );
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
