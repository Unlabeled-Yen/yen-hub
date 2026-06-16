"use client";

/**
 * ConversationListNav — the sidebar conversation list with Claude-style
 * interactions:
 *   - Click a row → continue that conversation (opens the Duffy palette on it).
 *   - Right-click a row (or click its ⋯) → context menu:
 *       重新命名 · 置頂/取消置頂 · 移到群組▸ · 刪除
 *   - Pinned conversations sort to the top; grouped ones render under their
 *     group header; the rest are ungrouped.
 */

import { useEffect, useRef, useState } from "react";
import {
  deleteConversation,
  listConversations,
  listGroups,
  loadFromServer,
  renameConversation,
  setGroup,
  setPinned,
  type Conversation,
} from "@/lib/conversations/store";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天`;
  return new Date(ts).toLocaleDateString("zh-TW", {
    month: "numeric",
    day: "numeric",
  });
}

function continueConversation(id: string) {
  window.dispatchEvent(
    new CustomEvent("yen:open-palette", { detail: { conversationId: id } }),
  );
}

type MenuState = {
  id: string;
  x: number;
  y: number;
  submenu: "group" | null;
  confirmDelete: boolean;
};

export function ConversationListNav({ pathname }: { pathname: string }) {
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  const refresh = () => setConvos(listConversations());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadFromServer();
      if (cancelled) return;
      refresh();
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Click-away / Esc closes the context menu.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenuAt = (id: string, x: number, y: number) =>
    setMenu({ id, x, y, submenu: null, confirmDelete: false });

  const startRename = (c: Conversation) => {
    setRenamingId(c.id);
    setRenameValue(c.title ?? "");
    setMenu(null);
  };
  const commitRename = (id: string) => {
    renameConversation(id, renameValue);
    setRenamingId(null);
    refresh();
  };

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

  const pinned = convos.filter((c) => c.pinned);
  const unpinned = convos.filter((c) => !c.pinned);
  const groupNames = Array.from(
    new Set(unpinned.map((c) => c.group).filter((g): g is string => !!g)),
  ).sort((a, b) => a.localeCompare(b));
  const ungrouped = unpinned.filter((c) => !c.group);

  const renderRow = (c: Conversation) => {
    if (renamingId === c.id) {
      return (
        <div key={c.id} className="px-3 py-1">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitRename(c.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(c.id);
              if (e.key === "Escape") setRenamingId(null);
            }}
            className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-2)] px-2 py-1 text-[12px] text-[var(--fg-0)] outline-none focus:border-[var(--accent)]"
          />
        </div>
      );
    }
    return (
      <div
        key={c.id}
        role="button"
        tabIndex={0}
        title={c.title ?? "未命名對話"}
        onClick={() => continueConversation(c.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") continueConversation(c.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenuAt(c.id, e.clientX, e.clientY);
        }}
        className="group flex cursor-pointer items-center gap-1 rounded px-3 py-1.5 text-[12px] text-[var(--fg-2)] transition-colors hover:bg-white/[0.03] hover:text-[var(--fg-1)]"
      >
        {c.pinned && (
          <span className="shrink-0 text-[var(--accent)]" title="已置頂">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M9.5 1.5 14 6l-3 1-3.5 3.5L7 14l-1.5-1.5L9 9 6 6l1-3z" />
            </svg>
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {c.title ?? "未命名對話"}
        </span>
        <span className="shrink-0 text-[10px] font-mono text-[var(--fg-3)] group-hover:hidden">
          {relTime(c.updatedAt)}
        </span>
        <button
          type="button"
          aria-label="對話選項"
          title="更多"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenuAt(c.id, r.right, r.bottom);
          }}
          className="hidden shrink-0 rounded p-0.5 text-[var(--fg-3)] hover:text-[var(--fg-1)] group-hover:block"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <circle cx="8" cy="3" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="8" cy="13" r="1.3" />
          </svg>
        </button>
      </div>
    );
  };

  const groupLabel = (name: string) => (
    <div className="px-3 pb-0.5 pt-2 text-[9px] font-mono uppercase tracking-[0.2em] text-[var(--fg-3)]">
      {name}
    </div>
  );

  const activeConvo = menu ? convos.find((c) => c.id === menu.id) : null;

  return (
    <div className="flex flex-col overflow-y-auto hub-scrollbar pr-1">
      {pinned.length > 0 && (
        <>
          {groupLabel("釘選")}
          {pinned.map(renderRow)}
        </>
      )}
      {groupNames.map((g) => (
        <div key={g}>
          {groupLabel(g)}
          {unpinned.filter((c) => c.group === g).map(renderRow)}
        </div>
      ))}
      {ungrouped.length > 0 && (
        <>
          {(pinned.length > 0 || groupNames.length > 0) && groupLabel("其他")}
          {ungrouped.map(renderRow)}
        </>
      )}

      {menu && activeConvo && (
        <div
          ref={menuRef}
          className="fixed z-[60] min-w-[164px] overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-2)] py-1 text-[13px] shadow-[0_8px_32px_-8px_rgba(0,0,0,0.6)]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.submenu === "group" ? (
            <>
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-[0.2em] text-[var(--fg-3)]">
                移到群組
              </div>
              {listGroups()
                .filter((g) => g !== activeConvo.group)
                .map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => {
                      setGroup(menu.id, g);
                      setMenu(null);
                      refresh();
                    }}
                    className="block w-full truncate px-3 py-2 text-left text-[var(--fg-1)] transition-colors hover:bg-white/[0.05]"
                  >
                    {g}
                  </button>
                ))}
              <button
                type="button"
                onClick={() => {
                  const name = window.prompt("新群組名稱");
                  if (name && name.trim()) {
                    setGroup(menu.id, name.trim());
                    setMenu(null);
                    refresh();
                  }
                }}
                className="block w-full px-3 py-2 text-left text-[var(--accent)] transition-colors hover:bg-white/[0.05]"
              >
                ＋ 新增群組…
              </button>
              {activeConvo.group && (
                <button
                  type="button"
                  onClick={() => {
                    setGroup(menu.id, null);
                    setMenu(null);
                    refresh();
                  }}
                  className="block w-full px-3 py-2 text-left text-[var(--fg-2)] transition-colors hover:bg-white/[0.05]"
                >
                  從群組移除
                </button>
              )}
            </>
          ) : menu.confirmDelete ? (
            <div className="px-3 py-2">
              <div className="mb-2 text-[12px] text-[var(--fg-2)]">
                徹底刪除？無法復原
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await deleteConversation(menu.id);
                    setMenu(null);
                    refresh();
                  }}
                  className="rounded px-2 py-1 text-[12px] font-mono uppercase tracking-[0.1em] text-[var(--warn)] hover:bg-[var(--warn)]/10"
                >
                  刪除
                </button>
                <button
                  type="button"
                  onClick={() => setMenu(null)}
                  className="rounded px-2 py-1 text-[12px] font-mono uppercase tracking-[0.1em] text-[var(--fg-3)] hover:text-[var(--fg-1)]"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <MenuItem label="重新命名" hint="R" onClick={() => startRename(activeConvo)} />
              <MenuItem
                label={activeConvo.pinned ? "取消置頂" : "置頂"}
                hint="P"
                onClick={() => {
                  setPinned(menu.id, !activeConvo.pinned);
                  setMenu(null);
                  refresh();
                }}
              />
              <MenuItem
                label="移到群組"
                chevron
                onClick={() => setMenu({ ...menu, submenu: "group" })}
              />
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <MenuItem
                label="刪除"
                hint="D"
                danger
                onClick={() => setMenu({ ...menu, confirmDelete: true })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  hint,
  chevron,
  danger,
  onClick,
}: {
  label: string;
  hint?: string;
  chevron?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-white/[0.05] ${
        danger ? "text-[var(--warn)]" : "text-[var(--fg-1)]"
      }`}
    >
      <span>{label}</span>
      {chevron ? (
        <span className="text-[var(--fg-3)]">›</span>
      ) : hint ? (
        <span className="font-mono text-[11px] text-[var(--fg-3)]">{hint}</span>
      ) : null}
    </button>
  );
}
