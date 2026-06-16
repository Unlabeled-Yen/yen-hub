"use client";

/**
 * ConversationsList — full-page list of past conversations (對話紀錄管理).
 *
 * Claude-style paths:
 *   - Click a row → continue that conversation (opens the Duffy palette loaded
 *     onto it via the `yen:open-palette` event; the palette switches active).
 *   - Hover → "⋯" overflow menu → 刪除對話 → confirm → permanent delete.
 */

import { useEffect, useState } from "react";
import { ConversationRowMenu } from "@/components/chat/conversation-row-menu";
import {
  listConversations,
  loadFromServer,
  type Conversation,
} from "@/lib/conversations/store";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return new Date(ts).toLocaleDateString("zh-TW");
}

/** Click = continue: open the Duffy palette onto this conversation. */
function continueConversation(id: string) {
  window.dispatchEvent(
    new CustomEvent("yen:open-palette", { detail: { conversationId: id } }),
  );
}

export function ConversationsList() {
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = () => setConvos(listConversations());

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
  }, []);

  return (
    <main className="flex-1 overflow-y-auto hub-scrollbar px-8 sm:px-12 pt-12 pb-16">
      <div className="duffy-panel mx-auto w-full max-w-3xl rounded-2xl border border-[var(--border-subtle)] p-6 sm:p-8">
        <div className="mb-6 flex items-baseline gap-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.32em] text-[var(--accent)]">
            對話紀錄
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.32em] text-[var(--fg-2)]">
            與 Duffy
          </span>
          <div className="h-px flex-1 bg-[var(--fg-3)] opacity-30" />
        </div>

        {!loaded ? (
          <div className="text-[13px] font-mono text-[var(--fg-3)]">載入中…</div>
        ) : convos.length === 0 ? (
          <div className="text-[13px] font-mono text-[var(--fg-3)]">
            尚無對話 —— 在任何畫面按下空白鍵即可開始跟 Duffy 對話。
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {convos.map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => continueConversation(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    continueConversation(c.id);
                  }
                }}
                className="group flex cursor-pointer items-center gap-4 rounded-lg border border-transparent px-4 py-3 transition-colors hover:border-[var(--border-subtle)] hover:bg-white/[0.03]"
              >
                <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--fg-1)] group-hover:text-[var(--fg-0)]">
                  {c.title ?? "未命名對話"}
                </span>
                <span className="flex shrink-0 items-baseline gap-3 text-[11px] font-mono text-[var(--fg-3)]">
                  <span>{c.messages.length} 則</span>
                  <span>{relTime(c.updatedAt)}</span>
                </span>
                <ConversationRowMenu
                  id={c.id}
                  onDeleted={refresh}
                  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
