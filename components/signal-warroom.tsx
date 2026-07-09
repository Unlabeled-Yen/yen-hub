"use client";

/**
 * SignalWarroom — Page 2 of /hub, redesigned as a WorldMonitor-style
 * situational-awareness console for AI signals.
 *
 * Redesign 2026-06-24 (presentation pass — logic unchanged):
 *   - IBM news upgraded from a title-only list to reading cards:
 *     title + 2-line 繁中 summary + topic chips + relative date.
 *   - Bottom grid widened to 3fr / 2fr so news (the reading focus) gets
 *     more room than the GitHub rail.
 *   - Loading swapped from clip-path "scan-reveal" to a staggered per-item
 *     fade-in (.item-reveal); skeletons now mimic the card shape.
 *   - 熱詞排行 rows gained a source colour tag (IBM / GitHub / 交集).
 *   - Each panel gets a hairline footer (source · updated · ZH status).
 *
 * Data: three independent sources, each its own cache + poll:
 *   /api/signals/ibm     · news cards (+ZH translation)
 *   /api/signals/github  · rising + active repos (+ZH)
 *   /api/signals/trends  · title-mined term frequencies + Z-scores
 */

import { useEffect, useMemo, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import { SignalBubbleField, type BubbleDatum } from "@/components/signal-bubble-field";
import { topicZh } from "@/lib/agent/signals/topic-labels";

/* ----------------------------------------------------------------- types -- */

type IbmItem = {
  id: string;
  title: string;
  titleZh: string | null;
  url: string;
  topic: string | null;
  topics: string[];
  summary: string;
  summaryZh: string | null;
  publishedAt: string | null;
};
type IbmPayload = {
  items: IbmItem[];
  translation?: { status: string };
  fetchedAt: number;
  stale?: boolean;
};

type Repo = {
  id: string;
  fullName: string;
  url: string;
  title: string;
  titleZh: string | null;
  stars: number;
  starsPerDay: number | null;
  language: string | null;
  llmTopics: string[];
};
type GhPayload = {
  rising: Repo[];
  active: Repo[];
  translation?: { status: string };
  fetchedAt: number;
  stale?: boolean;
};

type TermTrend = {
  term: string;
  count: number;
  recentCount: number;
  z: number;
  direction: "up" | "flat" | "down";
  source: "ibm" | "github" | "both";
};
type TrendReport = {
  mode: "frequency" | "trend";
  daysWithData: number;
  totalArticles: number;
  terms: TermTrend[];
};

/* ------------------------------------------------------------- utilities -- */

function openExternal(url: string) {
  import("@tauri-apps/plugin-opener")
    .then((m) => m.openUrl(url))
    .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
}

function fmtStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Relative date label for IBM article publish times. Falls back silently. */
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const day = 86_400_000;
  if (diffMs < day) return "今日";
  if (diffMs < 2 * day) return "昨日";
  const days = Math.floor(diffMs / day);
  if (days < 7) return `${days}天前`;
  return new Date(t).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

/** Source tag colour + label for the 熱詞排行 rows. */
const TERM_SOURCE: Record<TermTrend["source"], { label: string; color: string }> = {
  ibm: { label: "IBM", color: "#00e5b4" },
  github: { label: "GitHub", color: "#85b7eb" },
  both: { label: "交集", color: "#ffb878" },
};

/** Generic poll-while-pending fetch hook for the three signal endpoints. */
function useSignal<T>(url: string): { data: T | null; failed: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        const r = await tokenFetch(url, { credentials: "same-origin" });
        if (!r.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const json = (await r.json()) as T;
        if (cancelled) return;
        setData(json);
        setFailed(false);
        const meta = json as {
          translation?: { status: string };
          stale?: boolean;
        };
        if (meta.translation?.status === "pending" || meta.stale === true) {
          timer = setTimeout(run, 2500);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url]);
  return { data, failed };
}

/* ------------------------------------------------------------ subviews --- */

function Mark({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="text-[9px] font-mono tracking-[0.26em] uppercase"
      style={{ color }}
    >
      {label}
    </span>
  );
}

/** Scanning overlay — masks a panel while its translation is still in flight. */
function ScanOverlay({
  variant,
  label,
}: {
  variant?: "ibm" | "github";
  label?: string;
}) {
  return (
    <div className="scan-overlay" data-variant={variant} aria-hidden>
      {label ? (
        <span
          className="hairline-pulse absolute top-2.5 right-3 text-[9px] font-mono tracking-[0.3em] uppercase"
          style={{ color: variant === "github" ? "#85b7eb" : "var(--accent)" }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

/** Skeleton cards shown WHILE scanning — mirror the loaded news-card shape
 *  (two title lines + a short summary line) so the swap to real content
 *  doesn't jump the layout. */
function SkeletonCards({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-[10px] p-3"
          style={{ background: "rgba(255,255,255,0.02)" }}
        >
          <div className="skeleton-bar h-[13px]" style={{ width: `${78 + ((i * 7) % 16)}%` }} />
          <div className="skeleton-bar h-[13px]" style={{ width: `${54 + ((i * 11) % 18)}%` }} />
          <div className="skeleton-bar h-[9px]" style={{ width: `${30 + ((i * 9) % 14)}%`, opacity: 0.14 }} />
        </div>
      ))}
    </div>
  );
}

/** Skeleton rows for the narrower GitHub rail. */
function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="skeleton-bar h-[13px]" style={{ width: `${72 + ((i * 7) % 24)}%` }} />
          <div className="skeleton-bar h-[9px]" style={{ width: `${34 + ((i * 11) % 20)}%`, opacity: 0.12 }} />
        </div>
      ))}
    </div>
  );
}

/** One IBM news reading card — title + 繁中 summary + topic chips + date. */
function NewsCard({ item, i }: { item: IbmItem; i: number }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(item.url)}
      className="news-card item-reveal group"
      style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="news-title flex-1 text-[13.5px] leading-[1.45] text-[var(--fg-0)] transition-colors line-clamp-2">
          {item.titleZh ?? item.title}
        </div>
        {fmtDate(item.publishedAt) ? (
          <span className="shrink-0 pt-0.5 font-mono text-[9px] text-[var(--fg-3)] whitespace-nowrap">
            {fmtDate(item.publishedAt)}
          </span>
        ) : null}
      </div>
      {item.summaryZh ?? item.summary ? (
        <div className="text-[11.5px] leading-[1.55] text-[var(--fg-2)] line-clamp-2">
          {item.summaryZh ?? item.summary}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 flex-wrap">
        {(item.topics.length > 0 ? item.topics.slice(0, 2) : [item.topic ?? "Think"]).map(
          (t, k) => (
            <span key={k} className="topic-chip">
              {topicZh(t)}
            </span>
          ),
        )}
      </div>
    </button>
  );
}

/** One GitHub repo row — Chinese functional summary as the headline. */
function RepoRow({
  repo,
  rank,
  starColor,
}: {
  repo: Repo;
  rank: number;
  starColor: string;
}) {
  return (
    <button
      type="button"
      onClick={() => openExternal(repo.url)}
      className="repo-row group"
    >
      <span className="shrink-0 min-w-[18px] pt-0.5 font-mono text-[10px] text-[var(--fg-3)] tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] leading-[1.4] text-[var(--fg-0)] group-hover:text-[var(--accent)] transition-colors line-clamp-2">
          {repo.titleZh ?? repo.title}
        </span>
        <span className="mt-1 flex items-center gap-2 font-mono text-[10px] text-[var(--fg-3)]">
          <span style={{ color: starColor }}>★{fmtStars(repo.stars)}</span>
          {repo.starsPerDay != null ? <span>+{repo.starsPerDay}/日</span> : null}
          {repo.language ? <span>{repo.language}</span> : null}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------- warroom ---- */

let documentFreshLoad = true;

export function SignalWarroom() {
  const [freshLoad] = useState(() => {
    if (documentFreshLoad) {
      documentFreshLoad = false;
      return true;
    }
    return false;
  });
  const refreshQ = freshLoad ? "?refresh=1" : "";

  const { data: ibm } = useSignal<IbmPayload>(`/api/signals/ibm${refreshQ}`);
  const { data: gh } = useSignal<GhPayload>(`/api/signals/github${refreshQ}`);

  const [trends, setTrends] = useState<TrendReport | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let n = 0;
    const run = async () => {
      try {
        const r = await tokenFetch(
          "/api/signals/trends?window=14&recent=3&limit=14",
          { credentials: "same-origin" },
        );
        if (r.ok && !cancelled) setTrends((await r.json()) as TrendReport);
      } catch {
        /* silent */
      }
      n++;
      if (!cancelled && n < 8) timer = setTimeout(run, 5000);
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const [selected, setSelected] = useState<string | null>(null);
  const [layers, setLayers] = useState({ ibm: true, github: true });

  const bubbles: BubbleDatum[] = useMemo(() => {
    if (!trends) return [];
    return trends.terms.map((t) => ({
      term: t.term,
      value: trends.mode === "trend" ? Math.max(1, t.recentCount) : t.count,
      hot: trends.mode === "trend" && t.z >= 1 && t.direction === "up",
      source: t.source,
    }));
  }, [trends]);

  const visibleBubbles = bubbles.filter(
    (b) =>
      (b.source === "ibm" && layers.ibm) ||
      (b.source === "github" && layers.github) ||
      b.source === "both",
  );

  const ibmItems = ibm?.items ?? [];
  const filteredIbm = selected
    ? ibmItems.filter((it) => {
        const n = selected.toLowerCase();
        return (
          it.topics.some((t) => t.toLowerCase() === n) ||
          it.title.toLowerCase().includes(n) ||
          (it.titleZh?.toLowerCase().includes(n) ?? false)
        );
      })
    : ibmItems;

  const matchRepo = (r: Repo, term: string) => {
    const n = term.toLowerCase();
    return (
      r.llmTopics.some((t) => t.toLowerCase() === n) ||
      r.title.toLowerCase().includes(n) ||
      (r.titleZh?.toLowerCase().includes(n) ?? false)
    );
  };
  const allRising = gh?.rising ?? [];
  const allActive = gh?.active ?? [];
  const rising = selected
    ? allRising.filter((r) => matchRepo(r, selected))
    : allRising;
  const active = selected
    ? allActive.filter((r) => matchRepo(r, selected))
    : allActive;

  const hottestZ = trends ? Math.max(0, ...trends.terms.map((t) => t.z)) : 0;
  const heat =
    hottestZ >= 1.5 ? { label: "HIGH", color: "#e24b4a" } :
    hottestZ >= 0.8 ? { label: "ELEVATED", color: "#ffb878" } :
    { label: "NOMINAL", color: "#00e5b4" };

  const now = new Date(ibm?.fetchedAt ?? Date.now());

  const ibmScanning = !ibm || ibm.translation?.status === "pending";
  const ghScanning = !gh || gh.translation?.status === "pending";
  const bubbleScanning = !trends || trends.terms.length === 0;

  return (
    <div className="w-full">
      {/* ── status bar ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-1 py-2 border-b border-[var(--fg-3)]/30 mb-3">
        <span className="text-[12px] font-mono tracking-[0.28em] uppercase text-[var(--accent)]">
          SIGNALS
        </span>
        <span className="text-[10px] font-mono text-[var(--fg-3)]">v0.2</span>
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-[var(--accent)]">
          <span className="hairline-pulse inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
          LIVE
        </span>
        <span className="text-[10px] font-mono tracking-[0.18em] text-[var(--fg-3)] hidden sm:inline">
          IBM · GITHUB · 2 SOURCES
        </span>
        <span className="flex-1" />
        <span className="text-[10px] font-mono text-[var(--fg-2)]">
          熱度 <span style={{ color: heat.color }}>{heat.label}</span>
        </span>
        <span className="text-[10px] font-mono text-[var(--fg-3)] tabular-nums">
          {now.toLocaleTimeString()}
        </span>
      </div>

      {/* ── viz row: LAYERS | bubble field | 熱詞排行 ──────────── */}
      <div className="grid grid-cols-[148px_1fr] lg:grid-cols-[148px_1fr_270px] gap-0 border border-[var(--fg-3)]/25 rounded-xl overflow-hidden mb-4">
        <div className="border-r border-[var(--fg-3)]/25 p-4 bg-black/20">
          <Mark label="LAYERS" color="var(--accent)" />
          <div className="flex flex-col gap-3 mt-3 text-[12px]">
            <button
              type="button"
              onClick={() => setLayers((l) => ({ ...l, ibm: !l.ibm }))}
              className="flex items-center gap-2 text-left"
            >
              <span
                className="w-3 h-3 rounded-sm inline-block"
                style={{
                  background: layers.ibm ? "#00e5b4" : "transparent",
                  border: "1px solid #00e5b4",
                }}
              />
              <span className="text-[var(--fg-1)]">IBM 新聞</span>
            </button>
            <button
              type="button"
              onClick={() => setLayers((l) => ({ ...l, github: !l.github }))}
              className="flex items-center gap-2 text-left"
            >
              <span
                className="w-3 h-3 rounded-sm inline-block"
                style={{
                  background: layers.github ? "#378add" : "transparent",
                  border: "1px solid #378add",
                }}
              />
              <span className="text-[var(--fg-1)]">GitHub</span>
            </button>
            <div className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-sm inline-block"
                style={{ background: "#ffb878", border: "1px solid #ffb878" }}
              />
              <span className="text-[var(--fg-2)]">兩者交集</span>
            </div>
          </div>
          <div className="mt-4">
            <Mark label="狀態" color="var(--fg-3)" />
            <div className="mt-2 text-[10px] font-mono text-[var(--fg-2)] leading-relaxed">
              <div>{trends ? `${trends.totalArticles} 篇` : "—"}</div>
              <div>{trends ? `${trends.daysWithData} 天資料` : ""}</div>
              <div className="text-[var(--fg-3)]">
                {trends?.mode === "trend" ? "趨勢模式" : "頻率模式"}
              </div>
            </div>
          </div>
          {selected ? (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="mt-4 text-[10px] font-mono tracking-[0.2em] uppercase text-[var(--fg-2)] hover:text-[var(--accent)]"
            >
              ✕ 清除
            </button>
          ) : null}
        </div>

        <div className="relative p-3">
          <div className="absolute top-3 left-4 z-10">
            <Mark
              label="AI 訊號圖 · 大小=頻率 · 顏色=來源"
              color="var(--fg-3)"
            />
          </div>
          {visibleBubbles.length > 0 ? (
            <SignalBubbleField
              data={visibleBubbles}
              selected={selected}
              onSelect={setSelected}
              height={420}
            />
          ) : (
            <div className="relative flex items-center justify-center h-[420px] text-[12px] font-mono text-[var(--fg-3)]">
              {bubbleScanning ? <div className="radar-sweep" aria-hidden /> : null}
              <span className="relative z-10">
                {trends ? "掃描訊號源中…熱詞即將浮現" : "載入中…"}
              </span>
            </div>
          )}
          <div className="absolute bottom-2 left-3 flex gap-3 text-[9px] font-mono text-[var(--fg-3)]">
            <span><span style={{ color: "#00e5b4" }}>●</span> IBM</span>
            <span><span style={{ color: "#378add" }}>●</span> GitHub</span>
            <span><span style={{ color: "#ffb878" }}>●</span> 交集</span>
            <span>↑ = 異常熱 Z≥1</span>
          </div>
        </div>

        {/* 熱詞排行 — now with a source colour tag per row */}
        <div className="border-t lg:border-t-0 lg:border-l border-[var(--fg-3)]/25 p-4">
          <Mark label="熱詞排行 · AI INSIGHTS" color="#ffb878" />
          <div className="flex flex-col gap-3 mt-3 max-h-[388px] overflow-y-auto hub-scrollbar pr-1">
            {(trends?.terms ?? []).slice(0, 14).map((t) => {
              const max = Math.max(1, ...(trends?.terms ?? []).map((x) => x.recentCount || x.count));
              const v = trends?.mode === "trend" ? t.recentCount : t.count;
              const pct = Math.round((v / max) * 100);
              const isActive = selected === t.term;
              const zh = topicZh(t.term);
              const src = TERM_SOURCE[t.source];
              return (
                <button
                  key={t.term}
                  type="button"
                  onClick={() => setSelected(isActive ? null : t.term)}
                  className="flex flex-col gap-1.5 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[13px] flex-1 truncate"
                      style={{ color: isActive ? "var(--accent)" : "var(--fg-0)" }}
                    >
                      {zh}
                    </span>
                    <span className="text-[10px] font-mono text-[var(--fg-2)] shrink-0 tabular-nums">
                      {v}
                      {trends?.mode === "trend" && t.direction === "up" ? " ↑" : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 h-[5px] rounded-full bg-[var(--fg-3)]/20 overflow-hidden">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          background:
                            t.z >= 1 && t.direction === "up" ? "#00e5b4" : "#5aa0eb",
                        }}
                      />
                    </span>
                    <span
                      className="text-[9px] font-mono shrink-0 tracking-[0.08em]"
                      style={{ color: src.color }}
                    >
                      {src.label}
                    </span>
                  </div>
                  {zh !== t.term ? (
                    <span className="text-[10px] font-mono text-[var(--fg-3)] truncate">
                      {t.term}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {(trends?.terms ?? []).length === 0 ? (
              <div className="text-[11px] font-mono text-[var(--fg-3)]">累積資料中…</div>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── bottom panels: IBM news (wider, card layout) | GitHub ── */}
      <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-4">
        {/* IBM news */}
        <div className="relative border border-[var(--fg-3)]/25 rounded-xl overflow-hidden flex flex-col">
          {ibmScanning ? <ScanOverlay variant="ibm" label="翻譯掃描中" /> : null}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--fg-3)]/20">
            <Mark label="IBM · THINK" color="var(--accent)" />
            <span className="text-[10px] font-mono text-[var(--fg-3)]">
              {selected ? `${filteredIbm.length}/${ibmItems.length}` : `${ibmItems.length} 篇`}
            </span>
          </div>
          <div className="px-4 py-3 max-h-[380px] overflow-y-auto hub-scrollbar">
            {ibmScanning ? (
              <SkeletonCards rows={6} />
            ) : (
              <div className="flex flex-col gap-2">
                {filteredIbm.slice(0, 12).map((it, i) => (
                  <NewsCard key={it.id} item={it} i={i} />
                ))}
                {filteredIbm.length === 0 ? (
                  <div className="text-[11px] font-mono text-[var(--fg-3)] py-4">
                    {selected ? `無含「${selected}」的文章` : "載入中…"}
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <div className="px-4 py-2 border-t border-[var(--fg-3)]/20 flex items-center gap-2 text-[9px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
            <span>IBM THINK</span>
            <span>·</span>
            <span>UPDATED {now.toLocaleTimeString()}</span>
            {ibm?.translation ? (
              <>
                <span>·</span>
                <span className={ibm.translation.status === "ok" ? "text-[var(--accent)]" : "text-amber-400/80"}>
                  ZH · {ibm.translation.status}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {/* GitHub — 新星 + 活躍巨頭, two independent scroll areas */}
        <div className="relative border border-[var(--fg-3)]/25 rounded-xl overflow-hidden flex flex-col">
          {ghScanning ? <ScanOverlay variant="github" label="翻譯掃描中" /> : null}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--fg-3)]/20">
            <Mark label="GITHUB · AI 專案" color="#85b7eb" />
            <span className="text-[10px] font-mono text-[var(--fg-3)]">
              {allRising.length + allActive.length}
            </span>
          </div>
          <div className="flex flex-col min-h-0 flex-1">
            {/* 新星 */}
            <div className="px-3 pt-3 pb-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[10px] font-mono text-[var(--fg-2)]">
                  新星 · 近期竄起
                </span>
                <span className="text-[9px] font-mono text-[var(--fg-3)]">
                  {selected ? `${rising.length}/${allRising.length}` : allRising.length}
                </span>
              </div>
              <div className="max-h-[180px] overflow-y-auto hub-scrollbar">
                {ghScanning ? (
                  <SkeletonRows rows={4} />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {rising.slice(0, 12).map((r, i) => (
                      <div
                        key={r.id}
                        className="item-reveal"
                        style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
                      >
                        <RepoRow repo={r} rank={i + 1} starColor="var(--accent)" />
                      </div>
                    ))}
                    {rising.length === 0 ? (
                      <div className="text-[11px] font-mono text-[var(--fg-3)] px-3 py-2">
                        {selected ? `無含「${selected}」的專案` : "載入中…"}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>

            <div className="h-px bg-[var(--fg-3)]/20 mx-4 my-1" />

            {/* 活躍巨頭 */}
            <div className="px-3 pt-1 pb-3 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[10px] font-mono text-[var(--fg-2)]">
                  活躍巨頭 · 持續高熱
                </span>
                <span className="text-[9px] font-mono text-[var(--fg-3)]">
                  {selected ? `${active.length}/${allActive.length}` : allActive.length}
                </span>
              </div>
              <div className="max-h-[180px] overflow-y-auto hub-scrollbar">
                {ghScanning ? (
                  <SkeletonRows rows={4} />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {active.slice(0, 12).map((r, i) => (
                      <div
                        key={r.id}
                        className="item-reveal"
                        style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
                      >
                        <RepoRow repo={r} rank={i + 1} starColor="#85b7eb" />
                      </div>
                    ))}
                    {active.length === 0 ? (
                      <div className="text-[11px] font-mono text-[var(--fg-3)] px-3 py-2">
                        {selected ? `無含「${selected}」的專案` : "載入中…"}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="px-4 py-2 border-t border-[var(--fg-3)]/20 flex items-center gap-2 text-[9px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)] mt-auto">
            <span>GITHUB SEARCH</span>
            {gh?.translation ? (
              <>
                <span>·</span>
                <span className={gh.translation.status === "ok" ? "text-[#85b7eb]" : "text-amber-400/80"}>
                  ZH · {gh.translation.status}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
