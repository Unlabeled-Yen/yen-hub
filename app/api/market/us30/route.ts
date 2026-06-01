/**
 * GET /api/market/us30?tf=15m|2h|1d
 *
 * Primary source: **Twelve Data** (free tier, 8/min · 800/day).
 *
 * Twelve Data's free tier doesn't expose ^DJI directly, but the SPDR Dow
 * Jones ETF **DIA** tracks the index 1:1 (≈ DJI / 100). We fetch DIA OHLC
 * + quote, multiply all price fields by 100 to display familiar US30 /
 * DJI numbers, and label the source so it's clear we're using a proxy.
 *
 * Fallback source: **Stooq CSV** for ^DJI direct price (used when Twelve
 * Data is down or rate-limited). Stooq only gives one candle's worth, so
 * the chart degrades to a single bar in that case.
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
  source: "twelvedata" | "stooq";
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

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  try {
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

// ---------- Twelve Data (primary) ----------

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

// ---------- Stooq (fallback) ----------

async function fetchStooq(tf: Timeframe): Promise<Quote> {
  const res = await httpGet("https://stooq.com/q/l/?s=^dji&f=sd2t2ohlcv&h&e=csv");
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

  const cached = cache.get(tf);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return NextResponse.json(cached.quote);
  }

  // Source preference: Twelve Data (rich OHLC) → cached stale TD →
  // Stooq (single-bar fallback). Stale TD always wins over fresh Stooq
  // because Stooq only returns 1 candle which trashes the chart.
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

  // TD failed (or no key). Prefer last good TD cache (stale) over Stooq's
  // skinny single-bar payload, as long as the cache itself was TD.
  if (
    cached &&
    cached.quote.source === "twelvedata" &&
    Date.now() - cached.at < STALE_OK_MS
  ) {
    console.log(`[us30] tf=${tf} serving stale TD (${cached.quote.candles.length} candles)`);
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
