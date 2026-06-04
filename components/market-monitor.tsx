"use client";

/**
 * MarketMonitor — top-right of Page A.
 *
 * Three tabs (MARKET / US30 / VIX) sharing one panel chrome:
 *   - MARKET: macro overview (placeholder — FRED integration later)
 *   - US30:   YM=F continuous Dow futures, self-drawn OHLC + ATR sub-pane
 *             with 15m / 2h / 1d timeframe switcher (D/H/M nav)
 *   - VIX:    TradingView Advanced Chart widget (iframe embed)
 *
 * Data source chain for US30 (see /api/market/us30/route.ts):
 *   Yahoo YM=F → Twelve Data DIA×100 → Stooq ym.f
 *
 * Panel chrome (border accent, stale dot, fade-in) is shared across
 * tabs; only US30 gets warm orange/cream accent based on day change.
 */

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { CandleChart, type Candle } from "./candle-chart";
import { EASE } from "@/lib/animation/constants";
import { tokenFetch } from "@/lib/security/sidecar-token";

type Timeframe = "15m" | "2h" | "1d";
type Tab = "market" | "us30" | "ym1";

type Quote = {
  symbol: string;
  price: number;
  prev: number;
  change: number;
  changePct: number;
  candles: Candle[];
  marketState: string;
  updatedAt: number;
  source?: "yahoo" | "twelvedata" | "stooq";
  timeframe: Timeframe;
  stale?: boolean;
};

const TIMEFRAMES: Timeframe[] = ["15m", "2h", "1d"];

const TABS: { id: Tab; label: string }[] = [
  { id: "market", label: "MARKET" },
  { id: "us30", label: "US30" },
  { id: "ym1", label: "YM1!" },
];

function fmtHoverTime(t: number, tf: Timeframe): string {
  const d = new Date(t);
  if (tf === "1d") {
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    });
  }
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

// Neutral accent for non-US30 tabs (no up/down signal to bind to).
const NEUTRAL_BORDER = "rgba(255,255,255,0.10)";

export function MarketMonitor() {
  const [tab, setTab] = useState<Tab>("us30");
  const [tf, setTf] = useState<Timeframe>("1d");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  // Lazy mount the TradingView iframe — only after the user actually
  // clicks the VIX tab the first time. Once true, stays true so
  // switching back/forth doesn't re-init the widget (TV's bootstrap
  // is heavy and a remount can lock the webview).
  const [ym1Mounted, setYm1Mounted] = useState(false);
  useEffect(() => {
    if (tab === "ym1" && !ym1Mounted) setYm1Mounted(true);
  }, [tab, ym1Mounted]);

  // Poll US30 only when its tab is active. Avoids burning the TD budget
  // (8/min · 800/day) while the user is looking at MARKET or VIX.
  useEffect(() => {
    if (tab !== "us30") return;
    let cancelled = false;
    async function pull() {
      try {
        const r = await tokenFetch(`/api/market/us30?tf=${tf}`, {
          credentials: "same-origin",
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const json = (await r.json()) as Quote;
        if (!cancelled) {
          setQuote(json);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    pull();
    const id = setInterval(pull, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab, tf]);

  // Border accent: warm orange/cream only on US30 (driven by day change).
  // Other tabs: neutral grey so we don't fake a directional signal.
  const isUp = (quote?.change ?? 0) >= 0;
  const us30Accent = isUp ? "rgba(255,170,100,0.18)" : "rgba(235,225,185,0.18)";
  const borderColor = tab === "us30" ? us30Accent : NEUTRAL_BORDER;

  return (
    <section
      className="relative font-mono flex flex-col h-full"
      aria-label="market monitor"
      data-tauri-drag-region
    >
      {/* Tab strip — MARKET / US30 / VIX as inline text buttons.
          Replaced the old "Market — US30 · VIX · 波動率" header.
          波動率 dropped per Yen. */}
      <header className="flex items-center gap-5 text-[11px] tracking-[0.30em] uppercase mb-4 flex-shrink-0">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className="relative font-mono"
              style={{
                color: active ? "var(--fg-0)" : "var(--fg-2)",
                opacity: active ? 1 : 0.55,
                letterSpacing: "0.30em",
                fontSize: 11,
                background: "transparent",
                border: "none",
                padding: "2px 0",
                cursor: "pointer",
                transition: "color 200ms, opacity 200ms",
              }}
            >
              {t.label}
              {active ? (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: -2,
                    height: 1,
                    background: "rgba(255,184,120,0.55)",
                    boxShadow: "0 0 6px rgba(255,184,120,0.35)",
                  }}
                />
              ) : null}
            </button>
          );
        })}
        {/* Hover-time chip — only meaningful on US30 (CandleChart hover).
            Other tabs: stays empty so the slot doesn't shift. */}
        {tab === "us30" && hoverTime !== null ? (
          <span
            className="ml-auto text-[10px] tracking-[0.18em]"
            style={{
              color: "rgba(255,184,120,0.95)",
              textShadow: "0 0 6px rgba(255,184,120,0.35)",
            }}
          >
            {fmtHoverTime(hoverTime, tf)}
          </span>
        ) : null}
      </header>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.45, ease: EASE }}
        className="relative flex-1 flex flex-col"
        style={{
          minHeight: 520,
          borderRadius: 6,
          border: `1px solid ${borderColor}`,
          background: "transparent",
          padding: 0,
          gap: 12,
        }}
      >
        {/* Stale indicator — only on US30 since only that tab has an
            upstream that can go stale. */}
        {tab === "us30" && quote?.stale ? (
          <span
            title="stale (upstream rate-limited)"
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: 3,
              background: "rgba(255,180,80,0.85)",
              boxShadow: "0 0 6px rgba(255,180,80,0.5)",
              zIndex: 1,
            }}
          />
        ) : null}

        {/* Tab content */}
        {tab === "market" ? <MarketTabPlaceholder /> : null}

        {tab === "us30" ? (
          <div className="flex-1 min-h-0 flex flex-col">
            {quote && quote.candles.length > 0 ? (
              <CandleChart
                candles={quote.candles}
                timeframe={quote.timeframe}
                height={580}
                onHoverChange={(c) => setHoverTime(c ? c.t : null)}
              />
            ) : (
              <div
                className="flex-1 flex items-center justify-center text-[10px] tracking-[0.28em] uppercase"
                style={{ color: "var(--fg-2)", opacity: 0.55 }}
              >
                {err ? `error · ${err}` : "loading"}
              </div>
            )}
          </div>
        ) : null}

        {tab === "ym1" ? <Ym1TradingViewWidget mount={ym1Mounted} /> : null}

        {/* D/H/M nav — only relevant to US30's CandleChart. Other tabs
            either have no concept of timeframe (MARKET) or carry their
            own timeframe UI (TradingView widget). */}
        {tab === "us30" ? (
          <nav
            aria-label="timeframe"
            style={{
              position: "absolute",
              left: "calc(100% + 6px)",
              top: 24,
              width: 28,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              zIndex: 2,
            }}
          >
            {TIMEFRAMES.map((t) => {
              const active = t === tf;
              const letter = t === "1d" ? "D" : t === "2h" ? "H" : "M";
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTf(t)}
                  className="font-mono"
                  style={{
                    width: 28,
                    height: 24,
                    fontSize: 11,
                    letterSpacing: "0.04em",
                    textAlign: "center",
                    color: active ? "var(--fg-0)" : "var(--fg-2)",
                    background: active
                      ? "rgba(255,184,120,0.10)"
                      : "rgba(0,0,0,0.35)",
                    border: "1px solid",
                    borderColor: active
                      ? "rgba(255,184,120,0.40)"
                      : "rgba(255,255,255,0.08)",
                    borderRadius: 3,
                    cursor: "pointer",
                    transition:
                      "color 200ms, background 200ms, border-color 200ms",
                  }}
                  title={t}
                >
                  {letter}
                </button>
              );
            })}
          </nav>
        ) : null}
      </motion.div>
    </section>
  );
}

// ---------- Tab content components ----------

function MarketTabPlaceholder() {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-3 text-center"
      style={{ color: "var(--fg-2)", padding: 24 }}
    >
      <div
        className="text-[11px] tracking-[0.30em] uppercase"
        style={{ opacity: 0.7 }}
      >
        宏觀總覽
      </div>
      <div
        className="text-[10px] tracking-[0.18em]"
        style={{ opacity: 0.45 }}
      >
        FRED · Treasury · DXY · Yields · 即將推出
      </div>
    </div>
  );
}

function Ym1TradingViewWidget({ mount }: { mount: boolean }) {
  // TradingView "Advanced Chart" widget — iframe embed, no API key,
  // live data for the YM1!-equivalent (E-mini Dow front-month).
  //
  // Symbol picked carefully:
  //   - CME_MINI:YM1! → CME's official feed; blocked in embed by
  //     exchange licensing ("only available on TradingView" popup)
  //   - CAPITALCOM:US30 → Capital.com's Dow CFD, tracks YM1! tick-by-
  //     tick, freely embeddable, no popup. TV themselves use these
  //     partner CFDs as the free-tier proxy for licensed futures.
  //     Tiny basis vs the real future (usually < 5 pts), but 24×5,
  //     live, no key.
  //   - Fallback if CAPITALCOM ever breaks: OANDA:US30USD, FX:US30.
  //
  // No `sandbox` attribute: earlier version with sandbox locked up
  // the Tauri WebKit webview (TV's cross-origin postMessage /
  // cookie work fights sandbox into an infinite handshake). Default
  // cross-origin iframe isolation is strict enough.
  const url =
    "https://s.tradingview.com/widgetembed/?" +
    [
      "symbol=CAPITALCOM:US30",
      "interval=D",
      "theme=dark",
      "style=1",
      "timezone=America/New_York",
      "locale=en",
      "autosize=1",
      // Drawing tools (trend lines, fib, levels, etc.) live in the
      // left side toolbar. hide_side_toolbar=0 keeps it visible.
      "hide_side_toolbar=0",
      "studies=[]",
    ].join("&");

  return (
    <div
      className="flex-1 min-h-0 flex items-center justify-center"
      style={{ color: "var(--fg-2)" }}
    >
      {mount ? (
        <iframe
          src={url}
          title="TradingView YM1! (Dow futures) chart"
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            borderRadius: 5,
          }}
        />
      ) : (
        <span
          className="text-[10px] tracking-[0.28em] uppercase"
          style={{ opacity: 0.55 }}
        >
          loading widget
        </span>
      )}
    </div>
  );
}
