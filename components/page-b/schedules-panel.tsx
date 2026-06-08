"use client";

/**
 * SchedulesPanel — Slice 11.1 (Duffy-only creation).
 *
 * Pure list view. Schedule creation is now exclusively driven by talking
 * to Duffy in natural language — there is no manual form. The panel shows
 * what's running, with single-event badges + countdown + a cancel button
 * (cancel goes through propose-approve in 02 待辦, same as create).
 */

import { useCallback, useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

const POLL_MS = 30_000;

type ScheduleRow = {
  id: string;
  name: string;
  cron_expr: string;
  cron_description: string;
  action_kind: string;
  enabled: boolean;
  fire_count: number;
  last_fired_at: number | null;
  next_fire: string | null;
  one_shot: boolean;
  not_before: number | null;
  created_by: string;
};

function formatCountdown(targetMs: number, now: number): string {
  const diff = targetMs - now;
  if (diff <= 0) return "—";
  const total = Math.floor(diff / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const mins = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}天 ${hours}小時`;
  if (hours > 0) return `${hours}小時 ${mins}分`;
  return `${mins}分鐘`;
}

const ACTION_LABEL: Record<string, string> = {
  reminder: "提醒",
  git_unpushed_check: "git 巡檢",
  vault_zone_check: "vault zone",
};

export function SchedulesPanel() {
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [now, setNow] = useState<number>(0);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/schedules");
      if (!res.ok) return;
      const data = (await res.json()) as { schedules: ScheduleRow[] };
      setRows(data.schedules);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const display = rows ?? [];
  const enabledCount = display.filter((r) => r.enabled).length;

  const onCancel = async (s: ScheduleRow) => {
    if (cancellingId === s.id) return;
    setCancellingId(s.id);
    try {
      await tokenFetch(`/api/schedules/${s.id}/cancel-propose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rationale: `從排程面板提議取消「${s.name}」`,
        }),
      });
    } finally {
      setCancellingId(null);
    }
  };

  if (rows === null) {
    return (
      <div className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
        loading…
      </div>
    );
  }

  if (display.length === 0) {
    return (
      <div className="px-4 py-6 text-center border border-[var(--border-subtle)] rounded">
        <div className="text-[11px] text-[var(--fg-2)] mb-1">
          目前沒有排程
        </div>
        <div className="text-[9px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
          跟 Duffy 講「明天下午 1 點提醒我 X」、他會幫你排
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
        {enabledCount} 條啟用 / {display.length} 條總計
      </div>

      <div className="flex flex-col">
        {display.map((s, idx) => {
          const countdown = s.next_fire
            ? formatCountdown(new Date(s.next_fire).getTime(), now)
            : "—";
          const lastFired = s.last_fired_at
            ? new Date(s.last_fired_at).toLocaleString("zh-TW", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "未觸發";
          return (
            <div
              key={s.id}
              className="px-4 py-2.5 flex items-center gap-4"
              style={{
                borderTop: idx === 0 ? "1px solid var(--border-subtle)" : "none",
                borderBottom: "1px solid var(--border-subtle)",
                background: s.enabled
                  ? "rgba(255,255,255,0.015)"
                  : "rgba(255,255,255,0.005)",
                opacity: s.enabled ? 1 : 0.5,
              }}
            >
              {/* Name + meta */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                  <span className="text-[12px] text-[var(--fg-0)] truncate">
                    {s.name}
                  </span>
                  <span className="text-[9px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
                    {ACTION_LABEL[s.action_kind] ?? s.action_kind}
                  </span>
                  {s.one_shot && (
                    <span
                      className="text-[9px] font-mono tracking-[0.18em] uppercase px-1.5 py-0.5 rounded"
                      style={{
                        color: "var(--accent)",
                        border: "1px solid var(--accent)",
                        background: "rgba(0,229,180,0.05)",
                      }}
                    >
                      單次
                    </span>
                  )}
                  {!s.enabled && (
                    <span className="text-[9px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
                      已停用
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[var(--fg-2)] truncate font-mono">
                  {s.cron_description || s.cron_expr} · 觸發 {s.fire_count} 次 · 上次 {lastFired}
                </div>
              </div>

              {/* Countdown */}
              <div className="shrink-0 text-right">
                <div className="text-[9px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
                  下次
                </div>
                <div className="text-[11px] font-mono tabular-nums text-[var(--fg-1)]">
                  {s.enabled ? countdown : "—"}
                </div>
              </div>

              {/* Cancel */}
              {s.enabled && (
                <button
                  type="button"
                  onClick={() => onCancel(s)}
                  disabled={cancellingId === s.id}
                  title="提議取消這條排程（會出現在 02 待辦）"
                  className="shrink-0 px-2 py-1 text-[9px] font-mono tracking-[0.18em] uppercase rounded border text-[var(--fg-3)] hover:text-[var(--warn)] hover:border-[var(--warn)] transition-colors disabled:opacity-40"
                  style={{ borderColor: "rgba(255,255,255,0.10)" }}
                >
                  {cancellingId === s.id ? "..." : "取消"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
