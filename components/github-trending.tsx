"use client";

/**
 * GithubTrending — "GitHub · AI 熱門" section on the signal page.
 *
 * Two lists from /api/signals/github:
 *   - 新星 (rising): repos created recently that already gained stars
 *   - 活躍 (active): all-time most-starred AI repos with a recent push
 *
 * Mirrors the IBM card vocabulary (module-card, --fg-* / --accent, section
 * marks). Repo descriptions are translated to 繁中 in the background; we poll
 * while translation.status === "pending", same as the IBM monitor.
 */

import { useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type Repo = {
  id: string;
  fullName: string;
  url: string;
  title: string;
  titleZh: string | null;
  stars: number;
  starsPerDay: number | null;
  language: string | null;
  topics: string[];
  owner: string;
  avatar: string;
  createdAt: string;
  pushedAt: string;
};

type Payload = {
  rising: Repo[];
  active: Repo[];
  translation?: { status: string; translated: number };
  fetchedAt: number;
  stale?: boolean;
};

function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Crude language → dot color. Common AI-repo languages only. */
const LANG_COLOR: Record<string, string> = {
  Python: "#3572A5",
  TypeScript: "#3178C6",
  JavaScript: "#F1E05A",
  Rust: "#DEA584",
  Go: "#00ADD8",
  "Jupyter Notebook": "#DA5B0B",
  C: "#555555",
  "C++": "#F34B7D",
  Cuda: "#3A4E3A",
  Swift: "#F05138",
};

function RepoCard({ repo, rank }: { repo: Repo; rank: number }) {
  return (
    <button
      type="button"
      onClick={() => {
        import("@tauri-apps/plugin-opener")
          .then((m) => m.openUrl(repo.url))
          .catch(() => window.open(repo.url, "_blank", "noopener,noreferrer"));
      }}
      className="module-card group relative flex flex-col text-left rounded-2xl p-4 cursor-pointer"
      style={{ minHeight: 132 }}
    >
      <div className="flex items-start gap-3">
        <span className="text-[13px] font-mono text-[var(--fg-3)] tabular-nums pt-0.5">
          {String(rank).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-[var(--fg-0)] group-hover:text-[var(--accent)] transition-colors">
              {repo.fullName}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--fg-1)] line-clamp-3">
            {repo.titleZh ?? repo.title}
          </p>
        </div>
      </div>

      <div className="mt-auto pt-3 flex items-center gap-3 text-[11px] font-mono text-[var(--fg-2)]">
        <span className="flex items-center gap-1 text-[var(--accent)]">
          ★ {fmtStars(repo.stars)}
        </span>
        {repo.starsPerDay != null ? (
          <span title="平均每日新增星數（自建立起）">
            +{repo.starsPerDay}/日
          </span>
        ) : null}
        {repo.language ? (
          <span className="flex items-center gap-1">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: LANG_COLOR[repo.language] ?? "var(--fg-3)",
                display: "inline-block",
              }}
            />
            {repo.language}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function SubSection({
  num,
  name,
  hint,
  repos,
}: {
  num: string;
  name: string;
  hint: string;
  repos: Repo[];
}) {
  if (repos.length === 0) return null;
  return (
    <div className="mb-8">
      <div className="flex items-baseline gap-3 mb-4">
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--accent)]">
          {num}
        </span>
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
          {name}
        </span>
        <span className="text-[10px] text-[var(--fg-3)]">{hint}</span>
        <div className="flex-1 h-px bg-[var(--fg-3)] opacity-30" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {repos.map((r, i) => (
          <RepoCard key={r.id} repo={r} rank={i + 1} />
        ))}
      </div>
    </div>
  );
}

export function GithubTrending() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const doFetch = async () => {
      try {
        const r = await tokenFetch("/api/signals/github", {
          credentials: "same-origin",
        });
        if (!r.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const json = (await r.json()) as Payload;
        if (cancelled) return;
        setData(json);
        setFailed(false);
        if (json.translation?.status === "pending" || json.stale === true) {
          pollTimer = setTimeout(doFetch, 2500);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    doFetch();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  // Header always renders so the section is discoverable; body swaps.
  return (
    <section className="w-full mt-16">
      <header className="flex items-baseline gap-3 mb-6">
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--accent)]">
          GITHUB
        </span>
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
          AI 熱門專案
        </span>
        <div className="flex-1 h-px bg-[var(--fg-3)] opacity-30" />
        {loading ? (
          <span className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
            FETCHING…
          </span>
        ) : null}
      </header>

      {failed && !data ? (
        <div className="module-card rounded-2xl p-6 text-[13px] text-[var(--fg-1)]">
          <div className="text-[11px] font-mono tracking-[0.28em] uppercase text-[var(--accent)] mb-2">
            GITHUB UNAVAILABLE
          </div>
          <p>無法抓取 GitHub 趨勢（可能是 API rate limit）。稍後會自動重試。</p>
        </div>
      ) : data ? (
        <>
          <SubSection
            num="A"
            name="新星 · 近期竄起"
            hint="最近建立、已衝星"
            repos={data.rising}
          />
          <SubSection
            num="B"
            name="活躍巨頭 · 持續高熱"
            hint="星數最高、近期有更新"
            repos={data.active}
          />
          <div className="mt-4 flex items-center gap-3 text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
            <span>GITHUB SEARCH</span>
            <span>·</span>
            <span>UPDATED {new Date(data.fetchedAt).toLocaleTimeString()}</span>
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
                >
                  ZH · {data.translation.status}
                </span>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
