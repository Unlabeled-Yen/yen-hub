"use client";

/**
 * ConversationRowMenu — the "⋯" overflow menu on a conversation row
 * (Claude-style). Click "⋯" → popover with 刪除對話 → confirm → permanently
 * deletes via the store (DELETE /api/conversations/[id]).
 *
 * Used by both the sidebar list and the 對話紀錄管理 page so the path is
 * identical wherever a conversation appears.
 */

import { useEffect, useRef, useState } from "react";
import { deleteConversation } from "@/lib/conversations/store";

export function ConversationRowMenu({
  id,
  onDeleted,
  className,
}: {
  id: string;
  onDeleted?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click-away closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        aria-label="對話選項"
        title="更多"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
          setConfirming(false);
        }}
        className="rounded p-1 text-[var(--fg-3)] transition-colors hover:bg-white/10 hover:text-[var(--fg-1)]"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="8" cy="3" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="8" cy="13" r="1.3" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 min-w-[148px] overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-2)] py-1 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.6)]"
          onClick={(e) => e.stopPropagation()}
        >
          {!confirming ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setConfirming(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--warn)] transition-colors hover:bg-[var(--warn)]/10"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 4.5l.5 8a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9l.5-8" />
              </svg>
              刪除對話
            </button>
          ) : (
            <div className="px-3 py-2">
              <div className="mb-2 text-[12px] text-[var(--fg-2)]">
                徹底刪除？無法復原
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await deleteConversation(id);
                    close();
                    onDeleted?.();
                  }}
                  className="rounded px-2 py-1 text-[12px] font-mono uppercase tracking-[0.1em] text-[var(--warn)] transition-colors hover:bg-[var(--warn)]/10"
                >
                  刪除
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    close();
                  }}
                  className="rounded px-2 py-1 text-[12px] font-mono uppercase tracking-[0.1em] text-[var(--fg-3)] transition-colors hover:text-[var(--fg-1)]"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
