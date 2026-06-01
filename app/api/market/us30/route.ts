/**
 * GET /api/market/us30
 *
 * Proxy Yahoo Finance chart endpoint for ^DJI (Dow Jones / US30 underlier).
 * No API key. We wrap Yahoo with three layers of resilience because their
 * free unauthenticated edges 429 aggressively:
 *
 *   1. **Module-level fresh cache** — once we have a good response, serve
 *      it for FRESH_MS without re-fetching. The client polls every 60s; this
 *      ensures we only hit Yahoo once per minute even with React StrictMode
 *      double-mounts or multiple tabs.
 *   2. **Two-host fallback** — try query1 first, then query2. They sit on
 *      different edges and rate-limit independently.
 *   3. **Stale-while-error** — on upstream failure (429 or otherwise),
 *      keep returning the last good quote for up to STALE_OK_MS. Response
 *      includes `stale: true` so the UI can dim the indicator.
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
  stale?: boolean;
};

const FRESH_MS = 60_000;
const STALE_OK_MS = 30 * 60_000;

let cache: { quote: Quote; at: number } | null = null;

const YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const YAHOO_PATH = "/v8/finance/chart/%5EDJI?interval=5m&range=1d";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

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
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

async function fetchOneHost(host: string): Promise<Quote> {
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
  };
}

async function fetchYahoo(): Promise<Quote> {
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      return await fetchOneHost(host);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all yahoo hosts failed");
}

export async function GET() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // Layer 1: fresh cache hit — no upstream call.
  if (cache && Date.now() - cache.at < FRESH_MS) {
    return NextResponse.json(cache.quote);
  }

  try {
    const q = await fetchYahoo();
    cache = { quote: q, at: Date.now() };
    return NextResponse.json(q);
  } catch (e) {
    // Layer 3: serve stale if recent enough.
    if (cache && Date.now() - cache.at < STALE_OK_MS) {
      return NextResponse.json({ ...cache.quote, stale: true });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
