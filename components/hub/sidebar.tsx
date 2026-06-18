"use client";

/**
 * Sidebar — persistent left nav for /hub (Claude-app style).
 *
 * Top-level: Dashboard (/hub) · Duffy (/hub/page-b) · AI 辦公室 (placeholder).
 * When the Duffy section is active, the conversation list (ConversationListNav)
 * appears beneath it — click a row to continue, right-click for the menu.
 *
 * Collapsible: the whole column hides. Per Yen (2026-06-18) it starts
 * COLLAPSED on every entry into the hub — toggling (⌘S / the Duffy-badge
 * control) works within the session, but a fresh launch/reload always begins
 * collapsed (no persisted-expanded restore). A
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
import { ConversationListNav } from "@/components/hub/conversation-list-nav";

/** Shared link row styling for top-level + sub-items. */
function navRowCls(active: boolean): string {
  return [
    "group flex items-center gap-2 rounded-md px-3 py-2 text-[13px] transition-colors",
    active
      ? "bg-white/[0.06] text-[var(--fg-0)]"
      : "text-[var(--fg-2)] hover:text-[var(--fg-1)] hover:bg-white/[0.03]",
  ].join(" ");
}

export function Sidebar() {
  const pathname = usePathname();
  // Starts collapsed on every entry/reload (initial true also matches the SSR
  // render → no hydration mismatch). We intentionally do NOT restore an
  // expanded state from storage — Yen wants the hub to open with the left
  // column tucked away each time.
  const [collapsed, setCollapsed] = useState(true);

  const toggle = () => setCollapsed((c) => !c);

  // The collapse control lives next to the Duffy badge on the dashboard
  // (components/attention-grid.tsx), not in the sidebar header. It fires this
  // event; the sidebar owns the state. ⌘S (Ctrl+S) toggles too — works in
  // both states because this component stays mounted while collapsed (it just
  // renders null). preventDefault stops the webview's "save page" dialog.
  useEffect(() => {
    const onToggle = () => toggle();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("yen:toggle-sidebar", onToggle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("yen:toggle-sidebar", onToggle);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const inDuffy = pathname.startsWith("/hub/page-b");

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

        {/* Duffy sub-items — only when in the Duffy section: just the
            conversation list (Duffy's home is the "Duffy" link itself). */}
        {inDuffy && (
          <div className="mb-1 ml-3 flex flex-1 flex-col overflow-hidden border-l border-[var(--border-subtle)] pl-2">
            <ConversationListNav pathname={pathname} />
          </div>
        )}

        <Link
          href="/hub/skills"
          className={navRowCls(pathname.startsWith("/hub/skills"))}
        >
          Skill 管理中心
        </Link>

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
