"use client";

/**
 * ConversationView — read-only render of one conversation's full thread.
 *
 * Loads from the client store (getConversation after loadFromServer); on a
 * cold cache (deep link before hydration, or a conversation created in another
 * window) it falls back to GET /api/conversations/[id]. Messages are rendered
 * with the SAME <Turn> component the palette uses, so inline intent cards and
 * formatting match exactly.
 *
 * Continuing the thread: the "繼續對話" button sets it active and opens the
 * palette (the palette hydrates the active conversation on open). v1 keeps the
 * thread itself read-only.
 */

import type { UIMessage } from "ai";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Turn } from "@/components/chat/turn";
import {
  deleteConversation,
  getConversation,
  loadFromServer,
  setActiveId,
  type Conversation,
} from "@/lib/conversations/store";
import { tokenFetch } from "@/lib/security/sidecar-token";

export function ConversationView({ id }: { id: string }) {
  const router = useRouter();
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">(
    "loading",
  );
  const [armedDelete, setArmedDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadFromServer();
      let c = getConversation(id);
      if (!c) {
        // Cold cache — fetch the single thread directly.
        try {
          const r = await tokenFetch(`/api/conversations/${id}`);
          if (r.ok) {
            const data = (await r.json()) as { conversation: Conversation };
            c = data.conversation;
          }
        } catch {
          /* fall through to missing */
        }
      }
      if (cancelled) return;
      if (c) {
        setConvo(c);
        setState("ready");
      } else {
        setState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const continueChat = () => {
    setActiveId(id);
    // Tell the always-mounted palette to open on the active conversation.
    window.dispatchEvent(new CustomEvent("yen:open-palette"));
  };

  const handleDelete = async () => {
    await deleteConversation(id);
    router.push("/hub/conversations");
  };

  return (
    <main className="flex-1 overflow-y-auto hub-scrollbar px-8 sm:px-12 pt-12 pb-24">
      <div className="duffy-panel mx-auto w-full max-w-3xl rounded-2xl border border-[var(--border-subtle)] p-6 sm:p-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-baseline gap-3">
            <Link
              href="/hub/conversations"
              className="text-[11px] font-mono uppercase tracking-[0.28em] text-[var(--fg-2)] transition-colors hover:text-[var(--fg-0)]"
            >
              ← 對話紀錄
            </Link>
            {convo?.title && (
              <span className="truncate text-[13px] text-[var(--fg-1)]">
                {convo.title}
              </span>
            )}
          </div>
          {state === "ready" && (
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={continueChat}
                className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--fg-1)] transition-colors hover:border-[var(--accent)] hover:text-[var(--fg-0)]"
              >
                繼續對話
              </button>
              {armedDelete ? (
                <>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="rounded-md border border-[var(--warn)]/40 px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--warn)] transition-colors hover:bg-[var(--warn)]/10"
                  >
                    確定刪除
                  </button>
                  <button
                    type="button"
                    onClick={() => setArmedDelete(false)}
                    className="rounded-md px-2 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--fg-3)] transition-colors hover:text-[var(--fg-1)]"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setArmedDelete(true)}
                  title="徹底刪除這則對話"
                  className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--fg-2)] transition-colors hover:border-[var(--warn)]/50 hover:text-[var(--warn)]"
                >
                  刪除
                </button>
              )}
            </div>
          )}
        </div>

        {state === "loading" && (
          <div className="text-[13px] font-mono text-[var(--fg-3)]">載入中…</div>
        )}
        {state === "missing" && (
          <div className="text-[13px] font-mono text-[var(--fg-3)]">
            找不到這則對話（可能已刪除）。
          </div>
        )}
        {state === "ready" && convo && (
          <div className="flex flex-col gap-6">
            {convo.messages.map((m: UIMessage) => (
              <Turn
                key={m.id}
                role={m.role as "user" | "assistant" | "system"}
                parts={m.parts}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
