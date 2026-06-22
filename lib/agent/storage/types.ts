/**
 * Agent storage types — Intent / Observation / Silhouette / Summary.
 *
 * Designed SQL-friendly so the JSON-file storage layer (Slice 6 / 7A) can
 * migrate to SQLite / Turso in a later slice without touching call sites.
 *
 * Slice 7A additions (2026-06-02):
 *  - `importance` on Intent + Observation
 *  - `read_at` on Observation (badge unread-count uses this)
 *  - Silhouette type + 5 SOUL-style fields
 *  - Summary type (ISO week)
 *  - IntentKind extended to support silhouette_update + summary proposals
 */

// tz.ts is a dependency-free leaf module (no imports), so referencing it from
// this low-level types module introduces no cycle. ISO-week keying must agree
// with the Asia/Taipei Sunday trigger in summary-cron.
import { taipeiWallClock } from "@/lib/agent/duffy/tz";

/* -------------------------------------------------------------------------- */
/*  Provenance + Evidence (unchanged)                                         */
/* -------------------------------------------------------------------------- */

export type ProvenanceSource =
  | "user"
  | "agent"
  | "user-via-agent"
  | "legacy";

export type EvidenceRef =
  | {
      kind: "attention";
      zone: string;
      metric: "total" | "added" | "opened" | "hoardRatio";
      value: number;
      window?: number;
    }
  | {
      kind: "vault_file";
      path: string;
    }
  | {
      kind: "todo";
      file: string;
      text: string;
    }
  | {
      kind: "observation";
      id: string;
    };

/* -------------------------------------------------------------------------- */
/*  Observation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Slice 8 (B · 醒提主動) — observations may optionally carry an
 * `intention`: a record that Yen said he intends to do/finish/decide
 * something. Stale intentions (no touch for N days) are surfaced as
 * nudge cards by `duffy/stale-intentions.ts`.
 *
 * Naming caveat: `Intent` (the unifying proposal type) is unrelated to
 * `Intention` (a user-stated commitment). The collision is awkward but
 * the domains stay separate; we never store an Intention as an Intent.
 */
export type IntentionStatus = "open" | "in_progress" | "done" | "dropped";

export type IntentionMeta = {
  status: IntentionStatus;
  /** ms timestamp; optional — many intentions have no deadline. */
  target_date?: number;
  /** ms; bumped whenever Yen progresses or re-mentions the intention. */
  last_touched_at: number;
  /** Verbatim phrase that triggered Duffy to mark this as an intention. */
  source_text?: string;
};

export type ObservationPayload = {
  title: string;
  body: string;
  zone?: string;
  window?: { days: number };
  /** Slice 8: when this observation captures a commitment Yen made. */
  intention?: IntentionMeta;
  /** Slice 8: id of the observation this nudge is reminding Yen of.
   *  Renders as an orange-tinted card; coach card may surface it too. */
  nudge_for?: string;
  /** v2 Gap A: optional 保鮮期（ms epoch；proposeObservation 收 ISO date 後轉換）。 */
  valid_until?: number;
  /** v2 Gap A: 提案時若要推翻舊觀察，填其 observation id；materialize 時把舊的標 superseded。 */
  supersedes?: string;
};

export type Importance = "high" | "medium" | "low";

export type Observation = {
  id: string;
  source_intent: string;
  title: string;
  body: string;
  zone?: string;
  window?: { days: number };
  evidence: EvidenceRef[];
  source: Extract<ProvenanceSource, "agent" | "user-via-agent">;
  source_agent_id?: string;
  reason: string;
  created_at: number;
  importance: Importance;     // ← Slice 7A
  read_at?: number;           // ← Slice 7A (user 看過後標記;徽章用此算 unread)
  intention?: IntentionMeta;  // ← Slice 8 (mirrors payload.intention; mutable)
  nudge_for?: string;         // ← Slice 8 (set when this observation is a nudge)
  // ↓ v2 Gap A (2026-06-16) — 記憶保鮮 / 失效。三欄皆 optional，舊資料無此欄＝永遠有效。
  /** ms epoch；超過此刻此觀察視為過期，預設讀取路徑排除。未設＝永不過期。 */
  valid_until?: number;
  /** 被哪條新觀察推翻的 id；一旦設值即視為封存，預設讀取排除。 */
  superseded_by?: string;
  /** ms epoch；被 supersede 或人工封存的時刻。供稽核，不參與過濾判斷。 */
  archived_at?: number;
};

/* -------------------------------------------------------------------------- */
/*  Silhouette — Duffy's portrait of the user (5-field SOUL.md style)         */
/* -------------------------------------------------------------------------- */

export type SilhouetteField =
  | "identity"
  | "style"
  | "values"
  | "boundaries"
  | "priorities";

export type SilhouetteUpdatePayload = {
  /** Which field to update. "full" replaces all 5 in one shot (used by bootstrap). */
  field: SilhouetteField | "full";
  /** New value:
   * - if field === "full": JSON-stringified object with all 5 fields
   * - else: plain text replacing just that field */
  new_value: string;
  /** Why this update is being proposed — shown verbatim in approval card. */
  reason: string;
  /** Duffy's self-assessed confidence after this update lands. */
  confidence: "low" | "medium" | "high";
};

export type Silhouette = {
  id: string;
  version: number;            // monotonic; v1 = bootstrap, v2+ = updates
  identity: string;
  style: string;
  values: string;
  boundaries: string;
  priorities: string;
  confidence: "low" | "medium" | "high";
  source_intent: string;
  source_agent_id: string;    // "duffy"
  reason: string;             // mirrors intent.rationale at approval
  created_at: number;
};

/* -------------------------------------------------------------------------- */
/*  Summary — weekly snapshot                                                  */
/* -------------------------------------------------------------------------- */

export type SummaryKeyNumber = {
  label: string;              // e.g. "septic 區新增 / 開啟"
  value: string;              // e.g. "18 / 2"
  delta?: string;             // vs 上週,e.g. "+5 / -1"
};

export type SummaryPayload = {
  /** ISO week format e.g. "2026-W23" */
  week: string;
  headline: string;           // 一句話
  key_numbers: SummaryKeyNumber[];
  pattern: string;            // 一段話描述模式
  proposed_actions: string[]; // 下週可考慮的行動
  source_observations: string[]; // observation ids
};

export type Summary = {
  id: string;
  week: string;
  generated_at: number;
  headline: string;
  key_numbers: SummaryKeyNumber[];
  pattern: string;
  proposed_actions: string[];
  source_observations: string[];
  source_intent: string;
  source_agent_id: string;
  created_at: number;
};

/* -------------------------------------------------------------------------- */
/*  Intent — unifies all three proposal kinds                                  */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  Slice 9 — Execution payloads (vault writes, structured plans)             */
/*  All still gated by user approval; the kinds just describe the target.     */
/* -------------------------------------------------------------------------- */

export type FileCreatePayload = {
  /** Vault-relative path. Must not exist yet. */
  path: string;
  content: string;
  rationale: string;
};

export type FileEditPayload = {
  /** Vault-relative path. Must exist. */
  path: string;
  /** Exact substring to replace. Must appear EXACTLY ONCE in the file. */
  old_text: string;
  new_text: string;
  rationale: string;
};

export type TodoPlanItem = {
  text: string;
  category?: string;
};

export type TodoPlanPayload = {
  title: string;
  items: TodoPlanItem[];
  rationale: string;
};

/* -------------------------------------------------------------------------- */
/*  Slice 11 — Schedule (dynamic cron) payloads                                */
/* -------------------------------------------------------------------------- */

/** v1 ships two action kinds; v2 will add observation_review + custom_prompt
 *  once Slice 8.7B trust-tier lets us govern the high-power ones. */
export type ScheduleActionKind =
  | "git_unpushed_check"      // run `git status` against named repos
  | "vault_zone_check"        // surface zones that haven't moved in N days
  | "reminder"                // plain message — fires as a high-importance obs
  | "journal_interview";      // Slice journal — 21:00 nightly: surface a
                              // high-importance obs prompting Yen to start
                              // the 5-question interview in Duffy chat

export type ScheduleCreatePayload = {
  cron_expr: string;
  action_kind: ScheduleActionKind;
  /** Action-specific config; validated at approval time per action_kind. */
  action_payload: Record<string, unknown>;
  rationale: string;
  /** Human-friendly name shown in the dashboard. */
  name: string;
  /** When true, the scheduler disables this schedule after the first fire.
   *  Pair with not_before to express single events ("明天下午 1 點"). */
  one_shot?: boolean;
  /** Earliest ms timestamp at which this schedule may fire. Used together
   *  with cron_expr to express "after tomorrow 00:00, the first 13:00".
   *  Without this, "明天下午 1 點" would resolve to today's 1 PM if it
   *  hasn't passed yet. */
  not_before?: number;
};

export type ScheduleCancelPayload = {
  schedule_id: string;
  rationale: string;
};

export type Schedule = {
  id: string;                     // sched_xxx
  name: string;
  cron_expr: string;
  action_kind: ScheduleActionKind;
  action_payload: Record<string, unknown>;
  enabled: boolean;
  created_at: number;
  created_by: string;             // "duffy" or "yen"
  source_intent: string;
  last_fired_at?: number;
  fire_count: number;
  rationale: string;
  /** Slice 11.1 — single-event mode. */
  one_shot?: boolean;
  not_before?: number;
};

export type IntentKind =
  | "observation"
  | "silhouette_update"
  | "summary"
  | "file_create"
  | "file_edit"
  | "todo_plan"
  | "schedule_create"
  | "schedule_cancel";

/** Discriminated by `kind` at the Intent level. */
export type IntentPayload =
  | ObservationPayload
  | SilhouetteUpdatePayload
  | SummaryPayload
  | FileCreatePayload
  | FileEditPayload
  | TodoPlanPayload
  | ScheduleCreatePayload
  | ScheduleCancelPayload;

export type IntentStatus = "pending" | "approved" | "rejected";

/**
 * Slice 8.7B / 11.4 — trust tier governs how the propose-approve gate
 * behaves per intent:
 *   - L0: auto-execute (low-risk, reversible append-only) — UI shows
 *         "auto-executed, undo within 24h" instead of an approval card.
 *   - L1: standard one-tap approve (current behavior of all intents).
 *   - L2: double-confirm (irreversible / external / silhouette).
 *
 * Slice 11.4 plumbs the field through schema + decide route ONLY.
 * Behavior change (auto-execute, double-confirm UI, Trust Dial / Capability
 * Matrix) lands in Slice 8.7B v1. For now, all intents read as L1 if the
 * field is absent — same behavior as before this slice.
 */
export type TrustTier = "L0" | "L1" | "L2";

export type Intent = {
  id: string;
  kind: IntentKind;
  payload: IntentPayload;
  proposed_by: string;
  proposed_at: number;
  status: IntentStatus;
  rationale: string;
  evidence: EvidenceRef[];
  importance: Importance;     // ← Slice 7A
  decided_at?: number;
  decided_by?: "user" | "auto";  // ← Slice 8.7B v2: "auto" for L0 auto-execute
  resulted_in?: string;       // observation / silhouette / summary id
  /** Slice 8.7B / 11.4 — trust tier. Absent on legacy records → treated as L1. */
  trust_tier?: TrustTier;
  /** Slice 8.7B v2 — when this intent was auto-executed and later undone. */
  undone_at?: number;
};

/** Default trust tier per IntentKind. Slice 8.7B will let the user override
 *  via Capability Matrix; until then this is the only mapping.
 *
 *  L0 is reserved for kinds whose undo is mechanical and total — currently
 *  only `observation`. `todo_plan` was demoted to L1 because rolling back
 *  an appended Markdown block is fragile (Yen may have edited the file). */
export function defaultTrustTier(kind: IntentKind): TrustTier {
  switch (kind) {
    case "observation":
      return "L0";                  // delete from observations.json — clean undo
    case "todo_plan":
    case "summary":
    case "schedule_create":
    case "schedule_cancel":
    case "file_create":
      return "L1";                  // medium — review preview, one tap
    case "silhouette_update":
    case "file_edit":
      return "L2";                  // hard to reverse / portrait change
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function newIntentId(): string {
  return `int_${crypto.randomUUID()}`;
}

export function newObservationId(): string {
  return `obs_${crypto.randomUUID()}`;
}

export function newSilhouetteId(): string {
  return `sil_${crypto.randomUUID()}`;
}

export function newSummaryId(): string {
  return `sum_${crypto.randomUUID()}`;
}

export function newScheduleId(): string {
  return `sched_${crypto.randomUUID()}`;
}

/** ISO-week label for a Date, e.g. 2026-W23. */
export function isoWeek(d: Date = new Date()): string {
  // Anchor the calendar day to Asia/Taipei (not system local), then set to the
  // nearest Thursday per the ISO week definition.
  const wc = taipeiWallClock(d.getTime());
  const t = new Date(Date.UTC(wc.year, wc.month - 1, wc.dom));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Narrowing helpers for the payload union. */
export function isObservationPayload(
  intent: Intent,
): intent is Intent & { payload: ObservationPayload } {
  return intent.kind === "observation";
}

export function isSilhouetteUpdatePayload(
  intent: Intent,
): intent is Intent & { payload: SilhouetteUpdatePayload } {
  return intent.kind === "silhouette_update";
}

export function isSummaryPayload(
  intent: Intent,
): intent is Intent & { payload: SummaryPayload } {
  return intent.kind === "summary";
}

export function isFileCreatePayload(
  intent: Intent,
): intent is Intent & { payload: FileCreatePayload } {
  return intent.kind === "file_create";
}

export function isFileEditPayload(
  intent: Intent,
): intent is Intent & { payload: FileEditPayload } {
  return intent.kind === "file_edit";
}

export function isTodoPlanPayload(
  intent: Intent,
): intent is Intent & { payload: TodoPlanPayload } {
  return intent.kind === "todo_plan";
}

export function isScheduleCreatePayload(
  intent: Intent,
): intent is Intent & { payload: ScheduleCreatePayload } {
  return intent.kind === "schedule_create";
}

export function isScheduleCancelPayload(
  intent: Intent,
): intent is Intent & { payload: ScheduleCancelPayload } {
  return intent.kind === "schedule_cancel";
}
