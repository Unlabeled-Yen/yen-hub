"use client";

/**
 * SignalMonitor — Page 2 of /hub.
 *
 * AI 訊號抓取 MVP. 從 /api/signals/ibm 拉 IBM Think hub 的文章卡片，排版貼近
 * ibm.com/think：大字體標題、左對齊、卡片偶帶縮圖。視覺語彙沿用 .module-card
 * + globals.css 的 --fg-* / --accent token。
 *
 * 取資料：mount 時 fetch 一次。後端有 15 分鐘記憶體快取，這邊不額外重試 —
 * stale fallback 由 route 處理（payload.stale=true 時 header 會掛標記）。
 */

import { useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import { TrendStrip } from "@/components/signal-trend-strip";
import { GithubTrending } from "@/components/github-trending";

type Item = {
  id: string;
  title: string;
  titleZh: string | null;
  url: string;
  summary: string;
  summaryZh: string | null;
  image: string | null;
  topic: string | null;
  author: string | null;
  publishedAt: string | null;
  source: "ibm-think";
};

type TranslationStatus =
  | "ok"
  | "pending"
  | "no-key"
  | "timeout"
  | "parse-error"
  | "llm-error"
  | "partial";

type Payload = {
  items: Item[];
  translation?: {
    status: TranslationStatus;
    note?: string;
    translated: number;
  };
  fetchedAt: number;
  via: "html" | "stale";
  stale?: boolean;
};

function formatPublished(raw: string | null): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return "今天";
  if (days < 2) return "昨天";
  if (days < 30) return `${days} 天前`;
  return d.toISOString().slice(0, 10);
}

function openExternal(url: string) {
  // Tauri webview blocks regular target=_blank into a real browser; the
  // shell-open plugin is the canonical "open externally" path. Falls back
  // to window.open for plain dev browser.
  try {
    // dynamic import so we don't break SSR / non-Tauri dev
    import("@tauri-apps/plugin-opener")
      .then((m) => m.openUrl(url))
      .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function Card({ item }: { item: Item }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(item.url)}
      className="module-card group relative flex flex-col text-left rounded-2xl overflow-hidden cursor-pointer"
      style={{ minHeight: 260 }}
    >
      {item.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="w-full block"
          style={{
            aspectRatio: "16 / 9",
            objectFit: "cover",
            background: "rgba(255,255,255,0.03)",
          }}
          onError={(e) => {
            // Hide the broken image; the parent gradient fallback stays visible.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div
          className="w-full"
          style={{
            aspectRatio: "16 / 9",
            background:
              "linear-gradient(135deg, rgba(0,229,180,0.10), rgba(0,229,180,0.02))",
          }}
          aria-hidden
        />
      )}
      <div className="flex flex-1 flex-col gap-2 p-5">
        <div className="flex items-center gap-2 text-[10px] font-mono tracking-[0.28em] uppercase text-[var(--accent)]">
          <span>IBM · {item.topic ?? "Think"}</span>
          {item.publishedAt ? (
            <>
              <span className="text-[var(--fg-3)]">·</span>
              <span className="text-[var(--fg-2)] tracking-[0.18em]">
                {formatPublished(item.publishedAt)}
              </span>
            </>
          ) : null}
        </div>
        <h3 className="text-[17px] leading-[1.3] font-semibold text-[var(--fg-0)] line-clamp-3">
          {item.titleZh ?? item.title}
        </h3>
        {item.titleZh ? (
          <p className="text-[11px] leading-snug text-[var(--fg-3)] line-clamp-2 italic">
            {item.title}
          </p>
        ) : null}
        {(item.summaryZh || item.summary) ? (
          <p className="text-[13px] leading-relaxed text-[var(--fg-1)] line-clamp-5">
            {item.summaryZh ?? item.summary}
          </p>
        ) : null}
        <div className="mt-auto pt-3 flex items-center justify-between gap-3">
          {item.author ? (
            <span className="text-[11px] text-[var(--fg-2)] truncate">
              {item.author}
            </span>
          ) : (
            <span />
          )}
          <span className="text-[11px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] group-hover:text-[var(--accent)] transition-colors shrink-0">
            開啟 →
          </span>
        </div>
      </div>
    </button>
  );
}

function SkeletonCard() {
  return (
    <div
      className="module-card rounded-2xl overflow-hidden flex flex-col"
      style={{ minHeight: 260 }}
    >
      <div
        className="w-full"
        style={{
          aspectRatio: "16 / 9",
          background: "rgba(255,255,255,0.04)",
        }}
      />
      <div className="flex flex-col gap-2 p-5">
        <div className="h-3 w-24 rounded bg-[rgba(255,255,255,0.06)]" />
        <div className="h-4 w-full rounded bg-[rgba(255,255,255,0.08)]" />
        <div className="h-4 w-4/5 rounded bg-[rgba(255,255,255,0.06)]" />
      </div>
    </div>
  );
}

export function SignalMonitor() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);
    setError(null);

    const doFetch = async () => {
      try {
        const r = await tokenFetch("/api/signals/ibm", {
          credentials: "same-origin",
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const json = (await r.json()) as Payload;
        if (cancelled) return;
        setData(json);
        // Keep polling while:
        //   - translation is still running (pending → swap to Chinese)
        //   - cached payload is stale (server is refreshing in background;
        //     poll picks up the new data once SWR refresh completes)
        if (
          json.translation?.status === "pending" ||
          json.stale === true
        ) {
          pollTimer = setTimeout(doFetch, 2000);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    doFetch();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [reloadKey]);

  const allItems = data?.items ?? [];
  // Filter matches the term against the English title (the term is mined from
  // English titles) OR the Chinese title, so clicking a chip narrows the grid.
  const items = topicFilter
    ? allItems.filter((it) => {
        const needle = topicFilter.toLowerCase();
        return (
          it.title.toLowerCase().includes(needle) ||
          (it.titleZh?.toLowerCase().includes(needle) ?? false)
        );
      })
    : allItems;

  return (
    <section className="w-full">
      {/* 熱詞 / 趨勢 — title-mined term strip. */}
      <TrendStrip
        selected={topicFilter}
        onSelect={setTopicFilter}
        reloadKey={reloadKey}
      />

      {/* Header strip — mirrors page-b's hairline section mark vocabulary. */}
      <header className="flex items-baseline gap-3 mb-6">
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--accent)]">
          SIGNALS
        </span>
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
          AI 前沿 · IBM Think
        </span>
        <div className="flex-1 h-px bg-[var(--fg-3)] opacity-30" />
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] hover:text-[var(--accent)] disabled:opacity-40 transition-colors"
          aria-label="reload signals"
        >
          {loading ? "FETCHING…" : "REFRESH"}
        </button>
        {data?.stale ? (
          <span
            className="text-[10px] font-mono tracking-[0.24em] uppercase text-amber-400/80"
            title="upstream temporarily unavailable — showing cached"
          >
            STALE
          </span>
        ) : null}
      </header>

      {error && !items.length ? (
        <div className="module-card rounded-2xl p-6 text-[13px] text-[var(--fg-1)]">
          <div className="text-[11px] font-mono tracking-[0.28em] uppercase text-[var(--accent)] mb-2">
            FETCH FAILED
          </div>
          <p className="text-[var(--fg-1)]">
            無法從 IBM Think 抓取資料：<span className="font-mono">{error}</span>
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-4 text-[11px] font-mono tracking-[0.24em] uppercase text-[var(--accent)] hover:underline"
          >
            再試一次
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {loading && !items.length
            ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
            : items.map((it) => <Card key={it.id} item={it} />)}
        </div>
      )}

      {data ? (
        <div className="mt-8 flex items-center gap-3 text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
          <span>SOURCE · {data.via}</span>
          <span>·</span>
          <span>UPDATED {new Date(data.fetchedAt).toLocaleTimeString()}</span>
          <span>·</span>
          <span>
            {topicFilter
              ? `${items.length}/${allItems.length} · ${topicFilter}`
              : `${allItems.length} items`}
          </span>
          {data.translation ? (
            <>
              <span>·</span>
              <span
                className={
                  data.translation.status === "ok" ||
                  data.translation.status === "partial"
                    ? "text-[var(--accent)]"
                    : "text-amber-400/80"
                }
                title={data.translation.note ?? ""}
              >
                ZH · {data.translation.status} · {data.translation.translated}/
                {items.length}
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {/* GitHub AI 熱門專案 — independent fetch + poll, lives below IBM cards. */}
      <GithubTrending />
    </section>
  );
}
