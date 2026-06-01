/**
 * GET /api/market/us30
 *
 * US30 / Dow Jones quote with two-layer source fallback because Yahoo's
 * unauthenticated edges 429 aggressively from residential IPs:
 *
 *   Primary  → Yahoo (query1 → query2): full intraday 5m series + true
 *              previous close + market state.
 *   Fallback → Stooq CSV: only today's OHLC; we synthesize a 4-point
 *              sketch series (open/high/low/close) and use open as the
 *              change baseline. Marked source: "stooq" in the response.
 *
 * Resilience layers on top of source fallback:
 *   1. Module-level fresh cache (FRESH_MS) — first response good, serve
 *      from memory for 60s with no upstream call.
 *   2. Stale-while-error — on total upstream failure, last good quote
 *      keeps serving for STALE_OK_MS with `stale: true`.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Quote = {
  symbol: string;
  price: number;
  prev: number;
  change: number;
  changePct: number;
  series: number[];
  marketState: string;
  updatedAt: number;
  source: "yahoo" | "stooq";
  stale?: boolean;
};

const FRESH_MS = 60_000;
const STALE_OK_MS = 30 * 60_000;

let cache: { quote: Quote; at: number } | null = null;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// ---------- Yahoo ----------

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const YAHOO_PATH = "/v8/finance/chart/%5EDJI?interval=5m&range=1d";

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
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { description?: string } | null;
  };
};

async function fetchYahooHost(host: string): Promise<Quote> {
  const res = await fetch(host + YAHOO_PATH, {
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
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const series = closes.filter((v): v is number => typeof v === "number");
  const price = Number(meta.regularMarketPrice ?? series.at(-1) ?? 0);
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? price);
  const change = price - prev;
  const changePct = prev > 0 ? (change / prev) * 100 : 0;
  return {
    symbol: "US30",
    price,
    prev,
    change,
    changePct,
    series,
    marketState: meta.marketState ?? "CLOSED",
    updatedAt:
      (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
    source: "yahoo",
  };
}

async function fetchYahoo(): Promise<Quote> {
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      return await fetchYahooHost(host);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all yahoo hosts failed");
}

// ---------- Stooq ----------

async function fetchStooq(): Promise<Quote> {
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
  // No previous-close in this endpoint — use open as the intraday baseline.
  // Change becomes "session move" rather than "day vs yesterday".
  return {
    symbol: "US30",
    price: close,
    prev: open,
    change: close - open,
    changePct: open > 0 ? ((close - open) / open) * 100 : 0,
    series: [open, high, low, close],
    marketState: "CLOSED",
    updatedAt: Date.now(),
    source: "stooq",
  };
}

async function fetchAny(): Promise<Quote> {
  try {
    return await fetchYahoo();
  } catch (yahooErr) {
    try {
      return await fetchStooq();
    } catch (stooqErr) {
      throw new Error(
        `yahoo: ${yahooErr instanceof Error ? yahooErr.message : yahooErr}; stooq: ${stooqErr instanceof Error ? stooqErr.message : stooqErr}`,
      );
    }
  }
}

// ---------- Handler ----------

export async function GET() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  if (cache && Date.now() - cache.at < FRESH_MS) {
    return NextResponse.json(cache.quote);
  }

  try {
    const q = await fetchAny();
    cache = { quote: q, at: Date.now() };
    return NextResponse.json(q);
  } catch (e) {
    if (cache && Date.now() - cache.at < STALE_OK_MS) {
      return NextResponse.json({ ...cache.quote, stale: true });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
