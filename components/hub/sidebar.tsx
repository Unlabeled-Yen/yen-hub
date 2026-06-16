"use client";

/**
 * Sidebar — persistent left nav for /hub (Claude-app style).
 *
 * Top-level: Dashboard (/hub) · Duffy (/hub/page-b) · AI 辦公室 (placeholder).
 * When the Duffy section is active, reveals sub-items:
 *   Duffy 個人首頁 (/hub/page-b) · 對話紀錄管理 (/hub/conversations + list).
 *
 * Collapsible: the whole column hides (state persisted in localStorage); a
 * floating reopen pill sits top-left (clear of the macOS traffic lights). The
 * content area is `flex-1`, so when this column collapses the carousel /
 * page-b expand to fill — the overview carousel re-measures its width via
 * ResizeObserver.
 *
 * macOS traffic lights live top-LEFT, now over this column — the header
 * reserves headroom and carries `data-tauri-drag-region` so it doubles as the
 * window drag handle.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConversationRowMenu } from "@/components/chat/conversation-row-menu";
import {
  listConversations,
  loadFromServer,
  type Conversation,
} from "@/lib/conversations/store";

const COLLAPSE_KEY = "yen-hub:sidebar-collapsed";

/** Short relative time — "剛剛 / 5 分 / 3 時 / 2 天 / 日期". */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天`;
  return new Date(ts).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

/** Shared link row styling for top-level + sub-items. */
function navRowCls(active: boolean): string {
  return [
    "group flex items-center gap-2 rounded-md px-3 py-2 text-[13px] transition-colors",
    active
      ? "bg-white/[0.06] text-[var(--fg-0)]"
      : "text-[var(--fg-2)] hover:text-[var(--fg-1)] hover:bg-white/[0.03]",
  ].join(" ");
}

/** Conversation history list — lives under 對話紀錄管理 when Duffy is active. */
function ConversationNav({ pathname }: { pathname: string }) {
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Re-read on every navigation: loadFromServer() is idempotent (no-op once
  // hydrated) and the module-level cache is shared with the palette, so newly
  // created conversations show up after the next route change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadFromServer();
      if (cancelled) return;
      setConvos(listConversations());
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const refresh = () => setConvos(listConversations());

  if (!loaded) {
    return (
      <div className="px-3 py-2 text-[11px] font-mono text-[var(--fg-3)]">
        載入中…
      </div>
    );
  }
  if (convos.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] font-mono text-[var(--fg-3)]">
        尚無對話 · 按空白鍵開始
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-px overflow-y-auto hub-scrollbar pr-1">
      {convos.map((c) => (
        <div
          key={c.id}
          role="button"
          tabIndex={0}
          title={c.title ?? "未命名對話"}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("yen:open-palette", {
                detail: { conversationId: c.id },
              }),
            )
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              window.dispatchEvent(
                new CustomEvent("yen:open-palette", {
                  detail: { conversationId: c.id },
                }),
              );
            }
          }}
          className="group flex cursor-pointer items-center gap-1 rounded px-3 py-1.5 text-[12px] text-[var(--fg-2)] transition-colors hover:bg-white/[0.03] hover:text-[var(--fg-1)]"
        >
          <span className="min-w-0 flex-1 truncate">
            {c.title ?? "未命名對話"}
          </span>
          <span className="shrink-0 text-[10px] font-mono text-[var(--fg-3)] group-hover:hidden">
            {relTime(c.updatedAt)}
          </span>
          <ConversationRowMenu
            id={c.id}
            onDeleted={refresh}
            className="hidden shrink-0 group-hover:block"
          />
        </div>
      ))}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Hydrate collapse state from localStorage after mount (initial false
  // matches SSR → no hydration mismatch).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  // The collapse control lives next to the Duffy badge on the dashboard
  // (components/attention-grid.tsx), not in the sidebar header. It fires this
  // event; the sidebar owns the state.
  useEffect(() => {
    const onToggle = () => toggle();
    window.addEventListener("yen:toggle-sidebar", onToggle);
    return () => window.removeEventListener("yen:toggle-sidebar", onToggle);
  }, []);

  const inDuffy =
    pathname.startsWith("/hub/page-b") ||
    pathname.startsWith("/hub/conversations");

  // Collapsed → render only a floating reopen pill, clear of the traffic
  // Collapsed → render nothing. The single toggle beside the Duffy badge
  // (attention-grid.tsx) stays visible in the content area, so it re-expands
  // the sidebar — no separate floating pill needed.
  if (collapsed) return null;

  return (
    <aside className="sidebar-glass sticky top-0 self-start flex h-screen w-60 shrink-0 flex-col border-r border-[var(--border-subtle)]">
      {/* Header — traffic-light headroom + drag handle. The collapse toggle
          now lives beside the Duffy badge (attention-grid.tsx); this header is
          just clear space for the macOS lights + window dragging. */}
      <div data-tauri-drag-region className="h-12 shrink-0" />

      <nav className="flex flex-1 flex-col gap-1 overflow-hidden px-2 pt-2">
        <Link href="/hub" className={navRowCls(pathname === "/hub")}>
          Dashboard
        </Link>

        <Link href="/hub/page-b" className={navRowCls(inDuffy)}>
          Duffy
        </Link>

        {/* Duffy sub-items — only when in the Duffy section. */}
        {inDuffy && (
          <div className="mb-1 ml-3 flex flex-1 flex-col gap-px overflow-hidden border-l border-[var(--border-subtle)] pl-2">
            <Link
              href="/hub/page-b"
              className={navRowCls(pathname.startsWith("/hub/page-b"))}
            >
              Duffy 個人首頁
            </Link>
            <Link
              href="/hub/conversations"
              className={navRowCls(pathname === "/hub/conversations")}
            >
              對話紀錄管理
            </Link>
            <div className="mt-1 flex flex-1 flex-col overflow-hidden">
              <ConversationNav pathname={pathname} />
            </div>
          </div>
        )}

        {/* Placeholder for the future group-management page. */}
        <span
          aria-disabled
          className="mt-auto flex items-center gap-2 rounded-md px-3 py-2 text-[13px] text-[var(--fg-3)]"
          title="即將推出"
        >
          AI 辦公室
          <span className="text-[9px] font-mono uppercase tracking-[0.2em] opacity-70">
            soon
          </span>
        </span>
      </nav>

      <div className="px-4 py-3 text-[10px] font-mono uppercase tracking-[0.28em] text-[var(--fg-3)]">
        空白鍵 · 召喚 Duffy
      </div>
    </aside>
  );
}
