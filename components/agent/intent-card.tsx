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
import type { Intent } from "@/lib/agent/storage/types";

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

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch(`/api/intents/${intentId}`);
      if (res.status === 404) {
        setState({ kind: "missing" });
        return;
      }
      const data = (await res.json()) as { intent: Intent };
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
      try {
        const res = await tokenFetch(`/api/intents/${intentId}/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        const data = (await res.json()) as { intent: Intent };
        setState({ kind: "loaded", intent: data.intent });
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
    return (
      <div className="my-3 rounded-lg px-3 py-2 text-[11px] font-mono tracking-widest uppercase text-[var(--fg-3)] border border-[rgba(255,255,255,0.06)]">
        intent gone ({intentId.slice(0, 12)}…)
      </div>
    );
  }

  const intent = state.intent;
  const status = intent.status;
  const accent =
    status === "approved"
      ? "var(--success)"
      : status === "rejected"
        ? "var(--fg-2)"
        : "var(--accent)";

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
      {/* Header: agent + kind + status */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
          {intent.proposed_by} · {intent.kind}
        </div>
        <div
          className="text-[10px] font-mono tracking-[0.24em] uppercase"
          style={{ color: accent }}
        >
          {status}
        </div>
      </div>

      {/* Title */}
      <div className="text-[14px] leading-snug text-[var(--fg-0)] mb-2">
        {intent.payload.title}
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

      {/* Body (only when expanded) */}
      {expanded && intent.payload.body && (
        <div className="mt-2 text-[12px] leading-relaxed text-[var(--fg-1)] whitespace-pre-wrap">
          {intent.payload.body}
        </div>
      )}

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
