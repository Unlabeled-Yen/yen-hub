/**
 * GET /api/market/us30
 *
 * Proxy Yahoo Finance chart endpoint for ^DJI (Dow Jones Industrial Average,
 * the underlier behind US30 CFDs). No API key needed; we fetch server-side
 * to dodge browser CORS and Yahoo's bot UA check.
 *
 * Returns:
 *   {
 *     symbol: "US30",
 *     price: number,           // latest tick
 *     prev: number,            // previous close (for day-change calc)
 *     change: number,          // price - prev
 *     changePct: number,       // (change / prev) * 100
 *     series: number[],        // intraday closes (nulls dropped)
 *     marketState: "PRE"|"REGULAR"|"POST"|"CLOSED",
 *     updatedAt: number,       // unix ms
 *   }
 *
 * Cached at the edge for 60s — that's plenty for a sidebar tile.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const YAHOO_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EDJI?interval=5m&range=1d";

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

export async function GET() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const res = await fetch(YAHOO_URL, {
      headers: {
        // Yahoo serves an empty body to UAs it doesn't like.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        Accept: "application/json",
      },
      // Server-side cache; Next will serve stale up to 60s.
      next: { revalidate: 60 },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `yahoo ${res.status}` },
        { status: 502 },
      );
    }
    const json = (await res.json()) as YahooChart;
    const result = json.chart?.result?.[0];
    if (!result?.meta) {
      return NextResponse.json(
        { error: json.chart?.error?.description ?? "no result" },
        { status: 502 },
      );
    }
    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const series = closes.filter((v): v is number => typeof v === "number");
    const price = Number(meta.regularMarketPrice ?? series.at(-1) ?? 0);
    const prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? price);
    const change = price - prev;
    const changePct = prev > 0 ? (change / prev) * 100 : 0;
    return NextResponse.json({
      symbol: "US30",
      price,
      prev,
      change,
      changePct,
      series,
      marketState: meta.marketState ?? "CLOSED",
      updatedAt: (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
