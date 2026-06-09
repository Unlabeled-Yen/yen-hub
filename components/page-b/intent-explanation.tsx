"use client";

/**
 * IntentExplanation — Slice 元能力 #2 (v1).
 *
 * "Why did Duffy propose / auto-execute this?" view, surfacing fields
 * that already exist on the Intent but are scattered. No LLM call —
 * pure structured display of provenance + evidence.
 *
 * Used by:
 *   - IntentDeck card body (replaces the plain rationale paragraph)
 *   - IntentQueue's "近 24h 自動執行" mint area as a click-to-toggle
 *     popover so user can audit what Duffy auto-wrote
 *
 * Future v2 (per Slice 元能力 SPEC): add a "深挖" button that asks the LLM
 * to retrace its reasoning. Gated by Token Budget (Slice 元能力 #1).
 */

import type {
  Intent,
  ObservationPayload,
  ScheduleCreatePayload,
} from "@/lib/agent/storage/types";

const PROPOSER_LABEL: Record<string, { emoji: string; label: string }> = {
  duffy: { emoji: "🤖", label: "Duffy 對話" },
  "duffy-scheduler": { emoji: "⏰", label: "排程觸發" },
  yen: { emoji: "👤", label: "Yen 手動" },
  "duffy-bootstrap": { emoji: "🌱", label: "初始化" },
};

const TIER_LABEL: Record<string, string> = {
  L0: "L0 · 低風險（自動執行 / 24h 可撤）",
  L1: "L1 · 中風險（一鍵批准）",
  L2: "L2 · 不可逆（強制確認）",
};

const KIND_LABEL: Record<string, string> = {
  observation: "新觀察",
  silhouette_update: "更新剪影",
  summary: "週摘要",
  file_create: "建新檔",
  file_edit: "改既有檔",
  todo_plan: "待辦清單",
  schedule_create: "新排程",
  schedule_cancel: "取消排程",
};

function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "剛剛";
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString("zh-TW");
}

function evidenceLabel(e: Intent["evidence"][number]): {
  icon: string;
  text: string;
  hint: string;
} {
  switch (e.kind) {
    case "attention":
      return {
        icon: "📊",
        text: `${e.zone} · ${e.metric} ${e.value}${e.window ? ` / ${e.window}d` : ""}`,
        hint: `attention 訊號：${e.zone} zone 的 ${e.metric} 值 ${e.value}${e.window ? `（${e.window} 天窗口）` : ""}`,
      };
    case "vault_file":
      return {
        icon: "📄",
        text: e.path,
        hint: `來自 vault 檔案：${e.path}`,
      };
    case "todo":
      return {
        icon: "✓",
        text: `${e.text.slice(0, 30)}${e.text.length > 30 ? "…" : ""}`,
        hint: `來自 todo：${e.file}\n「${e.text}」`,
      };
    case "observation":
      return {
        icon: "👁",
        text: `obs ${e.id.slice(0, 10)}…`,
        hint: `來自過往觀察：${e.id}`,
      };
  }
}

/** Parse "Auto-fired by schedule \"X\" (action_kind)" rationale into a
 *  structured hint we can render as a link / tag. */
function parseScheduleRef(rationale: string): {
  schedule_name: string;
  action_kind: string;
} | null {
  const m = rationale.match(/Auto-fired by schedule "([^"]+)" \(([^)]+)\)/);
  if (!m) return null;
  return { schedule_name: m[1], action_kind: m[2] };
}

type Props = {
  intent: Intent;
  /** Compact mode hides some sections — for inline / popover use. */
  compact?: boolean;
};

export function IntentExplanation({ intent, compact }: Props) {
  const proposer = PROPOSER_LABEL[intent.proposed_by] ?? {
    emoji: "•",
    label: intent.proposed_by,
  };
  const tier = TIER_LABEL[intent.trust_tier ?? "L1"];
  const scheduleRef = parseScheduleRef(intent.rationale);
  const isNudge =
    intent.kind === "observation" &&
    Boolean((intent.payload as ObservationPayload).nudge_for);
  const sourceObsId =
    intent.kind === "observation"
      ? (intent.payload as ObservationPayload).nudge_for
      : undefined;

  return (
    <div className="flex flex-col gap-3 text-[11px] leading-relaxed">
      {/* Row 1: 時機 · 提案者 · 信任層 */}
      <div className="grid grid-cols-3 gap-3">
        <Field label="時機">
          <span className="text-[var(--fg-1)]">{formatWhen(intent.proposed_at)}</span>
        </Field>
        <Field label="提案者">
          <span className="text-[var(--fg-1)]">
            {proposer.emoji} {proposer.label}
          </span>
        </Field>
        <Field label="類型">
          <span className="text-[var(--fg-1)]">
            {KIND_LABEL[intent.kind] ?? intent.kind}
          </span>
        </Field>
      </div>

      {/* Row 2: 信任層 · 重要性 */}
      {!compact && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="信任層">
            <span className="text-[var(--fg-1)]">{tier}</span>
          </Field>
          <Field label="重要性">
            <span className="text-[var(--fg-1)]">
              {intent.importance === "high"
                ? "🔴 high"
                : intent.importance === "medium"
                  ? "🟡 medium"
                  : "⚪ low"}
            </span>
          </Field>
        </div>
      )}

      {/* Rationale */}
      <Field label="理由">
        <div className="text-[var(--fg-0)] whitespace-pre-wrap">
          {intent.rationale}
        </div>
      </Field>

      {/* Schedule reference (if scheduler-triggered) */}
      {scheduleRef && (
        <Field label="連動排程">
          <div className="flex items-center gap-2">
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-mono"
              style={{
                background: "rgba(0,229,180,0.06)",
                border: "1px solid var(--accent)",
                color: "var(--accent)",
              }}
            >
              ⏰ {scheduleRef.schedule_name}
            </span>
            <span className="text-[var(--fg-3)] text-[10px]">
              · {scheduleRef.action_kind}
            </span>
          </div>
        </Field>
      )}

      {/* Nudge source */}
      {isNudge && sourceObsId && (
        <Field label="醒提來源">
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-mono inline-block"
            style={{
              background: "rgba(240, 160, 90, 0.10)",
              border: "1px solid rgba(240, 160, 90, 0.5)",
              color: "#f0a05a",
            }}
            title={sourceObsId}
          >
            👁 {sourceObsId.slice(0, 14)}…
          </span>
        </Field>
      )}

      {/* Evidence */}
      {intent.evidence.length > 0 && (
        <Field label={`根據（${intent.evidence.length} 條）`}>
          <ul className="flex flex-col gap-1">
            {intent.evidence.map((e, i) => {
              const ev = evidenceLabel(e);
              return (
                <li
                  key={i}
                  className="flex items-baseline gap-2 text-[var(--fg-1)]"
                  title={ev.hint}
                >
                  <span>{ev.icon}</span>
                  <span className="font-mono text-[10px] truncate">
                    {ev.text}
                  </span>
                </li>
              );
            })}
          </ul>
        </Field>
      )}

      {/* Decision state if already decided */}
      {intent.status !== "pending" && intent.decided_at && (
        <Field label="決議">
          <span className="text-[var(--fg-2)]">
            {intent.status === "approved" ? "✓ 通過" : "✗ 拒絕"} ·{" "}
            {formatWhen(intent.decided_at)} ·{" "}
            {intent.decided_by === "auto" ? "自動" : "你"}
            {intent.undone_at && ` · 已撤銷 ${formatWhen(intent.undone_at)}`}
          </span>
        </Field>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[9px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
        {label}
      </div>
      {children}
    </div>
  );
}
