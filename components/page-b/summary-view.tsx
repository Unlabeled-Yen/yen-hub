"use client";

/**
 * SummaryView — bottom block of Page B.
 *
 * Shows the current ISO-week summary if one has been approved this week.
 * Otherwise: "no summary yet — Sunday cron will propose one".
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import type { Summary } from "@/lib/agent/storage/types";

type State =
  | { kind: "loading" }
  | { kind: "empty"; week: string }
  | { kind: "loaded"; summary: Summary }
  | { kind: "error"; message: string };

export function SummaryView() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/summaries/current");
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setState({ kind: "error", message: j.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as {
        summary: Summary | null;
        week: string;
      };
      setState(
        data.summary
          ? { kind: "loaded", summary: data.summary }
          : { kind: "empty", week: data.week },
      );
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: "easeOut", delay: 0.2 }}
      className="rounded-2xl p-6 pointer-events-auto"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--warn)]">
          本週摘要
        </div>
        {state.kind === "loaded" && (
          <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
            {state.summary.week}
          </div>
        )}
        {state.kind === "empty" && (
          <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
            {state.week}
          </div>
        )}
      </div>

      {state.kind === "loading" && (
        <div className="text-[14px] text-[var(--fg-3)]">loading…</div>
      )}

      {state.kind === "error" && (
        <div className="text-[12px] text-[var(--danger)]">
          summary error: {state.message}
        </div>
      )}

      {state.kind === "empty" && (
        <div className="text-[14px] leading-relaxed text-[var(--fg-2)]">
          本週還沒有摘要。週日晚的 cron 會自動提案一份；想立刻要的話，到 chat
          內請 Duffy 「propose summary 本週」。
        </div>
      )}

      {state.kind === "loaded" && (
        <div className="space-y-4">
          <div className="text-[16px] leading-relaxed text-[var(--fg-0)]">
            {state.summary.headline}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {state.summary.key_numbers.map((k, i) => (
              <div
                key={i}
                className="rounded-lg p-3"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)] mb-1">
                  {k.label}
                </div>
                <div className="text-[18px] font-mono tabular-nums text-[var(--fg-0)]">
                  {k.value}
                </div>
                {k.delta && (
                  <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-2)] mt-1">
                    {k.delta}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div>
            <div className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] mb-1">
              Pattern
            </div>
            <div className="text-[14px] leading-relaxed text-[var(--fg-1)] whitespace-pre-wrap">
              {state.summary.pattern}
            </div>
          </div>

          {state.summary.proposed_actions.length > 0 && (
            <div>
              <div className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] mb-1">
                Proposed actions
              </div>
              <ul className="text-[14px] leading-relaxed text-[var(--fg-1)] space-y-1">
                {state.summary.proposed_actions.map((a, i) => (
                  <li key={i}>· {a}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-2 text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
            from {state.summary.source_observations.length} observations ·
            generated {new Date(state.summary.created_at).toLocaleString("zh-TW")}
          </div>
        </div>
      )}
    </motion.div>
  );
}
