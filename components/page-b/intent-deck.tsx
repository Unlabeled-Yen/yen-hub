"use client";

/**
 * IntentDeck — Slice 8.7 Phase A.3 (lapel + deck pattern).
 *
 * Full-screen modal that surfaces pending intents one at a time as a
 * "card deck": top card centred and large, next 2 peeking through
 * underneath. Approving / rejecting flies the top card off in a direction
 * matching the verdict; skipping pushes it to the back.
 *
 * Keyboard:
 *   Y / Enter  → approve     (card flies right, mint)
 *   N          → reject      (card flies left, muted)
 *   S / Space  → skip        (card flies up, returns to back)
 *   Esc        → close deck
 *
 * Decisions hit /api/intents/:id/decide directly — we don't reuse
 * IntentCard because its inline-chat layout doesn't suit a focal deck.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import { IntentExplanation } from "@/components/page-b/intent-explanation";
import { kindLabel } from "@/lib/agent/intent-labels";
import { emitIntentEvent } from "@/lib/agent/intent-events";
import type {
  FileCreatePayload,
  FileEditPayload,
  Intent,
  ObservationPayload,
  ScheduleCancelPayload,
  ScheduleCreatePayload,
  SilhouetteUpdatePayload,
  SummaryPayload,
  TodoPlanPayload,
} from "@/lib/agent/storage/types";

type Props = {
  intents: Intent[];
  onClose: () => void;
  onDecided: () => void;
};

type Verdict = "approve" | "reject" | "skip";

/** Inline copy of IntentCard's describePayload — kept local so this
 *  component doesn't take a hard dep on internals of intent-card.tsx. */
function describePayload(intent: Intent): { title: string; body: string } {
  switch (intent.kind) {
    case "observation": {
      const p = intent.payload as ObservationPayload;
      return { title: p.title, body: p.body };
    }
    case "silhouette_update": {
      const p = intent.payload as SilhouetteUpdatePayload;
      const which =
        p.field === "full" ? "整份剪影" : `剪影的「${p.field}」欄位`;
      return {
        title: `更新 ${which}（confidence: ${p.confidence}）`,
        body: p.new_value,
      };
    }
    case "summary": {
      const p = intent.payload as SummaryPayload;
      const nums = p.key_numbers
        .map((k) => `${k.label}: ${k.value}`)
        .join(" · ");
      return {
        title: `${p.week} 週摘要：${p.headline}`,
        body: `${nums}\n\n${p.pattern}\n\n下一步建議：\n${p.proposed_actions.map((a) => `- ${a}`).join("\n")}`,
      };
    }
    case "file_create": {
      const p = intent.payload as FileCreatePayload;
      const preview =
        p.content.length > 800
          ? p.content.slice(0, 800) + "\n\n[…]"
          : p.content;
      return { title: `新檔：${p.path}`, body: preview };
    }
    case "file_edit": {
      const p = intent.payload as FileEditPayload;
      const body =
        `路徑：${p.path}\n\n` +
        `─── 舊（將被取代）───\n${p.old_text}\n\n` +
        `─── 新 ───\n${p.new_text}`;
      return { title: `編輯：${p.path}`, body };
    }
    case "todo_plan": {
      const p = intent.payload as TodoPlanPayload;
      const body = p.items
        .map((it) => `• ${it.text}${it.category ? ` (${it.category})` : ""}`)
        .join("\n");
      return {
        title: `待辦規劃：${p.title}（${p.items.length} 項）`,
        body,
      };
    }
    case "schedule_create": {
      const p = intent.payload as ScheduleCreatePayload;
      const payloadStr = JSON.stringify(p.action_payload, null, 2);
      const mode = p.one_shot ? "單次" : "週期";
      const notBefore = p.not_before
        ? new Date(p.not_before).toLocaleString("zh-TW", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null;
      return {
        title: `新排程：${p.name}（${mode}）`,
        body:
          `Cron：${p.cron_expr}\n` +
          `動作：${p.action_kind}\n` +
          (notBefore ? `不早於：${notBefore}\n` : "") +
          `Payload：${payloadStr}\n\n` +
          `理由：${p.rationale}`,
      };
    }
    case "schedule_cancel": {
      const p = intent.payload as ScheduleCancelPayload;
      return {
        title: `取消排程：${p.schedule_id}`,
        body: `理由：${p.rationale}`,
      };
    }
  }
}

export function IntentDeck({ intents, onClose, onDecided }: Props) {
  // Cursor moves forward only — decided/skipped cards leave the active set.
  // We snapshot the order on mount; new intents that arrive mid-session
  // can wait for the next deck opening so the user's flow stays predictable.
  const queue = useMemo(() => intents.slice(), [intents]);
  const [index, setIndex] = useState(0);
  const [exiting, setExiting] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);

  const top = queue[index];
  const remaining = queue.length - index;

  const advance = useCallback(() => {
    setIndex((i) => i + 1);
    setExiting(null);
  }, []);

  const decide = useCallback(
    async (verdict: Verdict) => {
      if (!top || busy) return;
      setBusy(true);
      setExiting(verdict);

      try {
        if (verdict !== "skip") {
          await tokenFetch(`/api/intents/${top.id}/decide`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision: verdict }),
          });
          // Bug fix（2026-06-12）：02 待辦 deck 的批准走這條，不是 intent-card。
          // 廣播給可能正在顯示衍生資料的面板（剪影、摘要等）— 它們才知道要重抓。
          emitIntentEvent({
            kind: top.kind,
            event: "decided",
            intentId: top.id,
            decision: verdict === "approve" ? "approved" : "rejected",
          });
          onDecided();
        }
      } catch {
        /* silent — surface in next poll */
      }

      // Wait for fly-out animation before advancing
      setTimeout(() => {
        advance();
        setBusy(false);
      }, 320);
    },
    [advance, busy, onDecided, top],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (!top) return;
      if (e.key === "y" || e.key === "Y" || e.key === "Enter") {
        e.preventDefault();
        void decide("approve");
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        void decide("reject");
      } else if (e.key === "s" || e.key === "S" || e.key === " ") {
        e.preventDefault();
        void decide("skip");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, decide, onClose, top]);

  // Cards behind the top (peek-through stack visual)
  const peek = [queue[index + 1], queue[index + 2]].filter(Boolean) as Intent[];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{ background: "rgba(0,0,0,0.78)", backdropFilter: "blur(8px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* ── Top bar: progress + close ─────────────────────────────── */}
      <div className="absolute top-6 left-0 right-0 px-8 flex items-center justify-between">
        <div className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
          審視中 · {Math.min(index + 1, queue.length)} / {queue.length}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] hover:text-[var(--fg-0)] transition-colors"
        >
          ESC 關閉
        </button>
      </div>

      {/* ── Card deck stage ───────────────────────────────────────── */}
      <div className="relative w-full max-w-[560px] h-[460px] flex items-center justify-center">
        {/* Peek-through stack (rendered behind top) */}
        {peek.map((p, i) => {
          const depth = i + 1;
          return (
            <div
              key={p.id}
              aria-hidden
              className="absolute inset-0 rounded-xl border"
              style={{
                background: "rgba(255,255,255,0.025)",
                borderColor: "rgba(255,255,255,0.08)",
                transform: `translateY(${depth * 14}px) scale(${1 - depth * 0.04})`,
                opacity: 1 - depth * 0.35,
                zIndex: -depth,
              }}
            />
          );
        })}

        {/* Top card */}
        <AnimatePresence mode="wait">
          {top && (
            <motion.div
              key={top.id}
              initial={{ opacity: 0, y: 30, scale: 0.95 }}
              animate={
                exiting === "approve"
                  ? { opacity: 0, x: 400, rotate: 15 }
                  : exiting === "reject"
                    ? { opacity: 0, x: -400, rotate: -15 }
                    : exiting === "skip"
                      ? { opacity: 0, y: -300 }
                      : { opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }
              }
              exit={{ opacity: 0 }}
              transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
              className="relative w-full h-full rounded-xl border flex flex-col"
              style={{
                background: "var(--bg-0)",
                borderColor: "var(--accent)",
                boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
              }}
            >
              {/* Card header */}
              <div className="px-6 pt-5 pb-3 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] font-mono tracking-[0.18em]"
                    style={{
                      background: "rgba(0,229,180,0.08)",
                      border: "1px solid var(--accent)",
                      color: "var(--accent)",
                    }}
                    title={`這是一張「${kindLabel(top.kind)}」卡 · 你的通過/拒絕會累積這個類別的信任分數，夠高就會被建議「升級」成自動執行`}
                  >
                    {kindLabel(top.kind)}
                  </span>
                  <span className="text-[9px] font-mono tracking-[0.32em] uppercase text-[var(--fg-3)]">
                    {top.proposed_by}
                  </span>
                </div>
                <div className="text-[16px] leading-snug text-[var(--fg-0)]">
                  {describePayload(top).title}
                </div>
              </div>

              {/* Card body — payload (the proposal content itself) */}
              <div className="px-6 py-4 flex-1 overflow-y-auto">
                <div className="text-[12px] text-[var(--fg-1)] leading-relaxed whitespace-pre-wrap mb-4">
                  {describePayload(top).body}
                </div>

                {/* Slice 元能力 #2 — structured "why" panel replaces the
                    plain italic rationale + standalone evidence chips. */}
                <details className="mt-4 border-t border-[var(--border-subtle)] pt-3">
                  <summary
                    className="cursor-pointer text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)] hover:text-[var(--fg-1)] select-none"
                    style={{ listStyle: "none" }}
                  >
                    ▸ Duffy 為什麼提這個
                  </summary>
                  <div className="mt-3">
                    <IntentExplanation intent={top} />
                  </div>
                </details>
              </div>
            </motion.div>
          )}

          {/* Empty / finished state */}
          {!top && (
            <motion.div
              key="done"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center"
            >
              <div
                className="text-[64px] mb-4 opacity-60"
                style={{ color: "var(--accent)" }}
              >
                ✓
              </div>
              <div className="text-[14px] text-[var(--fg-1)] mb-1">
                你已審視完所有卡片
              </div>
              <div className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
                {queue.length} 張 ·{" "}
                {queue.filter((_, i) => i < index).length} 已過
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Actions ───────────────────────────────────────────────── */}
      {top ? (
        <div className="mt-10 flex items-center gap-4">
          <ActionButton
            label="N · 拒絕"
            kbd="N"
            onClick={() => decide("reject")}
            disabled={busy}
            variant="reject"
          />
          <ActionButton
            label="S · 跳過"
            kbd="S"
            onClick={() => decide("skip")}
            disabled={busy}
            variant="skip"
          />
          <ActionButton
            label="Y · 通過"
            kbd="Y"
            onClick={() => decide("approve")}
            disabled={busy}
            variant="approve"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onClose}
          className="mt-10 px-5 py-2 text-[10px] font-mono tracking-[0.32em] uppercase rounded border border-[var(--accent)] text-[var(--accent)] hover:bg-[rgba(0,229,180,0.06)] transition-colors"
        >
          收起
        </button>
      )}

      {/* ── Hint footer ───────────────────────────────────────────── */}
      <div className="absolute bottom-6 text-[9px] font-mono tracking-[0.32em] uppercase text-[var(--fg-3)]">
        鍵盤：Y 通過 · N 拒絕 · S 跳過 · ESC 關閉
      </div>
    </motion.div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  variant,
}: {
  label: string;
  kbd: string;
  onClick: () => void;
  disabled: boolean;
  variant: "approve" | "reject" | "skip";
}) {
  const styles = (() => {
    switch (variant) {
      case "approve":
        return {
          background: "rgba(0, 229, 180, 0.12)",
          border: "1px solid var(--accent)",
          color: "var(--accent)",
        };
      case "reject":
        return {
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.18)",
          color: "var(--fg-1)",
        };
      case "skip":
        return {
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.10)",
          color: "var(--fg-3)",
        };
    }
  })();

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-5 py-2.5 text-[11px] font-mono tracking-[0.28em] uppercase rounded transition-opacity disabled:opacity-40 hover:opacity-80"
      style={styles}
    >
      {label}
    </button>
  );
}

function evidenceLabel(e: Intent["evidence"][number]): string {
  switch (e.kind) {
    case "attention":
      return `${e.zone} · ${e.metric} ${formatNum(e.value)}${
        e.window ? ` / ${e.window}d` : ""
      }`;
    case "vault_file":
      return e.path;
    case "todo":
      return `todo · ${truncate(e.text, 24)}`;
    case "observation":
      return `obs · ${e.id.slice(0, 10)}…`;
  }
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
