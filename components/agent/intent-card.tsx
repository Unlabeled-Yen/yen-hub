"use client";

/**
 * IntentCard — Slice 6 / Duffy v0.
 *
 * Renders a Pending / Approved / Rejected intent inline in the chat stream.
 * Used by the chat renderer when it encounters a `<<INTENT:int_xxx>>` sentinel
 * in an assistant message.
 *
 * Visual notes (sticking to the Yen Hub palette in `tokens.css`):
 *   - Pending: accent (mint-cyan) hairline border, body collapsed by default
 *   - Approved: success border, faded after a beat
 *   - Rejected: muted fg-2 border, body greyed out
 *   - Rationale clamps to one line per Q2 decision; click to expand
 *   - Evidence chips: tiny mono labels like `septic 9.0 / 7d`
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import { kindLabel } from "@/lib/agent/intent-labels";
import { emitIntentEvent } from "@/lib/agent/intent-events";
import type {
  Intent,
  ObservationPayload,
  SilhouetteUpdatePayload,
  SummaryPayload,
  FileCreatePayload,
  FileEditPayload,
  TodoPlanPayload,
  ScheduleCreatePayload,
  ScheduleCancelPayload,
} from "@/lib/agent/storage/types";

/** Slice 8 — observation intents with `nudge_for` are stale-intention
 *  reminders. They render in warm-amber instead of mint, to feel distinct
 *  from fresh observations (which are about now), and signal "this is an
 *  older commitment surfacing again". */
function isNudge(intent: Intent): boolean {
  if (intent.kind !== "observation") return false;
  return Boolean((intent.payload as ObservationPayload).nudge_for);
}

/** Extract a header (title + body) suitable for the card from any payload kind. */
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
        p.content.length > 600 ? p.content.slice(0, 600) + "\n\n[…]" : p.content;
      return {
        title: `新檔：${p.path}`,
        body: preview,
      };
    }
    case "file_edit": {
      const p = intent.payload as FileEditPayload;
      const body =
        `路徑：${p.path}\n\n` +
        `─── 舊（將被取代）───\n${p.old_text}\n\n` +
        `─── 新 ───\n${p.new_text}`;
      return {
        title: `編輯：${p.path}`,
        body,
      };
    }
    case "todo_plan": {
      const p = intent.payload as TodoPlanPayload;
      const body = p.items
        .map((it) => `• ${it.text}${it.category ? ` _(${it.category})_` : ""}`)
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

type Props = {
  intentId: string;
};

type FetchState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "loaded"; intent: Intent };

export function IntentCard({ intentId }: Props) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch(`/api/intents/${intentId}`);
      if (res.status === 404) {
        setState({ kind: "missing" });
        return;
      }
      const data = (await res.json()) as { intent?: Intent };
      if (!data.intent) {
        setState({ kind: "missing" });
        return;
      }
      setState({ kind: "loaded", intent: data.intent });
    } catch {
      setState({ kind: "missing" });
    }
  }, [intentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (decision: "approve" | "reject") => {
      if (state.kind !== "loaded") return;
      if (state.intent.status !== "pending") return;
      setBusy(true);
      setDecideError(null);
      try {
        const res = await tokenFetch(`/api/intents/${intentId}/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        // Server returns { intent } on success, { error } on failure
        // (422 invalid cron, 401 session, 500 materialize). Blindly
        // reading data.intent used to crash the whole page to Next's
        // global-error when the server said no — keep the card alive
        // and surface the message instead.
        const data = (await res.json().catch(() => ({}))) as {
          intent?: Intent;
          error?: string;
        };
        if (!res.ok || !data.intent) {
          setDecideError(data.error ?? `server error (${res.status})`);
          return;
        }
        setState({ kind: "loaded", intent: data.intent });
        // 廣播給可能正在顯示衍生資料的面板（剪影面板等）— 它們才知道要重抓
        emitIntentEvent({
          kind: data.intent.kind,
          event: "decided",
          intentId: data.intent.id,
          decision: data.intent.status === "approved" ? "approved" : "rejected",
        });
      } catch (e) {
        setDecideError(e instanceof Error ? e.message : "network error");
      } finally {
        setBusy(false);
      }
    },
    [intentId, state],
  );

  if (state.kind === "loading") {
    return (
      <div className="my-3 rounded-lg px-3 py-2 text-[11px] font-mono tracking-widest uppercase text-[var(--fg-3)] border border-[rgba(255,255,255,0.06)]">
        loading intent…
      </div>
    );
  }

  if (state.kind === "missing") {
    // Structural guardrail (2026-06-15): a sentinel whose id isn't in the
    // store means Duffy emitted `<<INTENT:…>>` with no real intent behind it.
    // Confirmed failure mode (flight recorder, turn_mqf55thu): Duffy narrated
    // "兩個新任務 pending 已建立" and hand-typed two fake UUIDs WITHOUT calling
    // propose_new_file. Don't render a dead approval affordance — say plainly
    // that nothing was created, so Yen re-states the request instead of
    // hunting for a button that can never work.
    return (
      <div className="my-3 rounded-lg px-3 py-2 text-[12px] leading-relaxed border border-amber-400/25 bg-amber-400/[0.04] text-amber-300/90">
        <div className="mb-1 font-mono text-[10px] tracking-widest uppercase text-amber-400/70">
          ⚠ 無效提案 · invalid intent
        </div>
        Duffy 宣稱建立了提案，但 store 裡查無此 intent（
        <span className="font-mono">{intentId.slice(0, 12)}…</span>）。多半是它
        發了 sentinel 卻沒實際呼叫 propose 工具——沒有東西被建立、也沒有東西可
        批准。請重述一次需求讓它重做。
      </div>
    );
  }

  const intent = state.intent;
  const status = intent.status;
  const nudge = isNudge(intent);
  // Warm amber for nudges, mint for fresh proposals. Approved/rejected
  // colours win regardless — past decisions don't need the nudge tint.
  const pendingAccent = nudge ? "#f0a05a" : "var(--accent)";
  const accent =
    status === "approved"
      ? "var(--success)"
      : status === "rejected"
        ? "var(--fg-2)"
        : pendingAccent;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{
        opacity: status === "rejected" ? 0.5 : 1,
        y: 0,
      }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="my-3 rounded-lg px-4 py-3 pointer-events-auto"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${accent}`,
        boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
      }}
    >
      {/* Header: agent + kind (+ nudge tag) + status */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)] flex items-center gap-2">
          <span
            className="px-1.5 py-0.5 rounded normal-case tracking-[0.18em]"
            style={{
              background: "rgba(0,229,180,0.08)",
              border: "1px solid var(--accent)",
              color: "var(--accent)",
            }}
            title={`「${kindLabel(intent.kind)}」卡 · 審核會累積此類別的信任分數`}
          >
            {kindLabel(intent.kind)}
          </span>
          <span>{intent.proposed_by}</span>
          {nudge && (
            <span
              className="px-1.5 py-0.5 rounded text-[9px] tracking-[0.18em]"
              style={{
                background: "rgba(240, 160, 90, 0.12)",
                border: "1px solid rgba(240, 160, 90, 0.5)",
                color: "#f0a05a",
              }}
            >
              醒提
            </span>
          )}
        </div>
        <div
          className="text-[10px] font-mono tracking-[0.24em] uppercase"
          style={{ color: accent }}
        >
          {status}
        </div>
      </div>

      {/* Title — describes the proposal regardless of kind */}
      <div className="text-[14px] leading-snug text-[var(--fg-0)] mb-2">
        {describePayload(intent).title}
      </div>

      {/* Rationale — one-line clamp, click to expand (Q2 decision) */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="block w-full text-left text-[12px] leading-relaxed text-[var(--fg-1)] cursor-pointer hover:text-[var(--fg-0)] transition-colors"
        title={intent.rationale}
      >
        <span
          className={
            expanded
              ? "whitespace-pre-wrap"
              : "whitespace-nowrap overflow-hidden text-ellipsis block"
          }
        >
          {intent.rationale}
        </span>
        {!expanded && (
          <span className="text-[10px] font-mono tracking-widest uppercase text-[var(--fg-3)] ml-2">
            …more
          </span>
        )}
      </button>

      {/* Body (only when expanded) — kind-aware via describePayload */}
      {expanded && (() => {
        const body = describePayload(intent).body;
        return body ? (
          <div className="mt-2 text-[12px] leading-relaxed text-[var(--fg-1)] whitespace-pre-wrap">
            {body}
          </div>
        ) : null;
      })()}

      {/* Evidence chips */}
      {intent.evidence.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {intent.evidence.map((e, i) => (
            <EvidenceChip key={i} evidence={e} />
          ))}
        </div>
      )}

      {/* Actions */}
      {status === "pending" ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("approve")}
            className="px-3 py-1.5 text-[11px] font-mono tracking-[0.24em] uppercase rounded transition-opacity disabled:opacity-40"
            style={{
              background: "rgba(0, 229, 180, 0.10)",
              border: "1px solid var(--accent)",
              color: "var(--accent)",
            }}
          >
            Yes 記下
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("reject")}
            className="px-3 py-1.5 text-[11px] font-mono tracking-[0.24em] uppercase rounded transition-opacity disabled:opacity-40"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.10)",
              color: "var(--fg-2)",
            }}
          >
            No 不用
          </button>
        </div>
      ) : (
        <Provenance intent={intent} />
      )}
      {decideError && (
        <div className="mt-2 text-[11px] leading-relaxed" style={{ color: "#f0a05a" }}>
          決定沒成功：{decideError}
        </div>
      )}
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Evidence chip                                                             */
/* -------------------------------------------------------------------------- */

function EvidenceChip({
  evidence,
}: {
  evidence: Intent["evidence"][number];
}) {
  let label = "";
  switch (evidence.kind) {
    case "attention":
      label = `${evidence.zone} · ${evidence.metric} ${formatNum(evidence.value)}${
        evidence.window ? ` / ${evidence.window}d` : ""
      }`;
      break;
    case "vault_file":
      label = evidence.path;
      break;
    case "todo":
      label = `todo · ${truncate(evidence.text, 24)}`;
      break;
    case "observation":
      label = `obs · ${evidence.id.slice(0, 10)}…`;
      break;
  }
  return (
    <span
      className="px-1.5 py-0.5 text-[10px] font-mono tracking-wide rounded"
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "var(--fg-2)",
      }}
    >
      {label}
    </span>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/* -------------------------------------------------------------------------- */
/*  Provenance — shown after a decision                                       */
/* -------------------------------------------------------------------------- */

function Provenance({ intent }: { intent: Intent }) {
  const proposedAt = new Date(intent.proposed_at).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const decidedAt = intent.decided_at
    ? new Date(intent.decided_at).toLocaleString("zh-TW", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <div className="mt-3 text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
      {intent.proposed_by} 提案 {proposedAt}
      {decidedAt && ` · ${intent.status} ${decidedAt}`}
      {intent.resulted_in && ` · obs ${intent.resulted_in.slice(0, 10)}…`}
    </div>
  );
}
