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

/**
 * Canonical Chinese label per intent kind — the SINGLE source of truth.
 *
 * The 審卡 cards (intent-deck / intent-card), the "why" panel
 * (intent-explanation), and the Trust-tier "升級" banner (tier-suggestion)
 * all read from here. Before this module each surface kept its own copy and
 * they drifted ("觀察" vs "新觀察"), so the category a user approved on a card
 * didn't visibly match the category name Duffy used when asking to auto-
 * promote it. Keeping one map guarantees card-label == banner-label.
 */
export const KIND_LABEL: Record<Intent["kind"], string> = {
  observation: "觀察",
  silhouette_update: "剪影更新",
  summary: "週摘要",
  file_create: "新檔建立",
  file_edit: "檔案編輯",
  todo_plan: "待辦規劃",
  schedule_create: "排程建立",
  schedule_cancel: "排程取消",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as Intent["kind"]] ?? kind;
}

/**
 * Per-kind plain-Chinese descriptions, used by the Trust-tier upgrade banner.
 *
 * Before this map the banner only said "把『觀察』升為自動執行?" — which assumes
 * the user already knows (a) what an "觀察" concretely is and (b) what
 * "auto-execute" means for THAT particular kind. We surface both:
 *
 *   - whatIsIt: one concrete sentence answering "this kind of card is Duffy
 *               trying to ___"
 *   - autoMeans: one sentence answering "if I upgrade, the next time Duffy
 *               wants to do this, ___ will happen"
 *
 * Both kept tight and scannable — the goal is "user reads in 5 seconds and
 * knows what they're approving", not a full doc page.
 */
export const KIND_META: Record<
  Intent["kind"],
  { whatIsIt: string; autoMeans: string }
> = {
  observation: {
    whatIsIt: "Duffy 對你當下狀態寫的小筆記（存進 vault 的 Observations）",
    autoMeans: "新觀察直接寫入，不再彈卡問你",
  },
  silhouette_update: {
    whatIsIt: "Duffy 對「你是誰」的描繪（剪影檔）想做的更新",
    autoMeans: "Duffy 直接改剪影，不再彈卡",
  },
  summary: {
    whatIsIt: "Duffy 對本週的總結（存進 vault 的 Summaries）",
    autoMeans: "週摘要直接生成入庫",
  },
  file_create: {
    whatIsIt: "Duffy 想在 vault 新建一個檔案",
    autoMeans: "Duffy 直接建檔，不再彈卡（仍會出現在最近異動）",
  },
  file_edit: {
    whatIsIt: "Duffy 想改 vault 裡某個現有檔案的內容",
    autoMeans: "Duffy 直接改檔，不再彈卡（仍會出現在最近異動）",
  },
  todo_plan: {
    whatIsIt: "Duffy 想幫你排一份待辦清單",
    autoMeans: "Duffy 直接排進待辦，不再彈卡",
  },
  schedule_create: {
    whatIsIt: "Duffy 想加一條新排程（自動定時觸發某動作）",
    autoMeans: "Duffy 直接加排程，不再彈卡",
  },
  schedule_cancel: {
    whatIsIt: "Duffy 想停掉某條排程",
    autoMeans: "Duffy 直接停排程，不再彈卡",
  },
};

export function kindMeta(kind: string): { whatIsIt: string; autoMeans: string } {
  return (
    KIND_META[kind as Intent["kind"]] ?? {
      whatIsIt: "Duffy 想做的一個動作",
      autoMeans: "之後直接執行，不再彈卡",
    }
  );
}

/**
 * One-line plain-Chinese preview of an intent's payload — used by the
 * Trust-tier banner's "看 N 條最近通過" examples list so the user can see
 * the *actual content* of past approvals (not just the category name).
 *
 * Returns the most identifying field per kind (title for observations, path
 * for files, name for schedules, etc.), so a user scanning 3 examples can
 * recognise "yeah, those are the kind of things I approved".
 */
export function intentOneLiner(intent: Intent): string {
  switch (intent.kind) {
    case "observation":
      return (intent.payload as ObservationPayload).title;
    case "silhouette_update": {
      const p = intent.payload as SilhouetteUpdatePayload;
      const which = p.field === "full" ? "整份剪影" : `「${p.field}」欄位`;
      return `更新 ${which}`;
    }
    case "summary":
      return (intent.payload as SummaryPayload).headline;
    case "file_create":
      return `新檔：${(intent.payload as FileCreatePayload).path}`;
    case "file_edit":
      return `改檔：${(intent.payload as FileEditPayload).path}`;
    case "todo_plan": {
      const p = intent.payload as TodoPlanPayload;
      return `${p.title}（${p.items.length} 項）`;
    }
    case "schedule_create": {
      const p = intent.payload as ScheduleCreatePayload;
      return `新排程：${p.name}`;
    }
    case "schedule_cancel": {
      const p = intent.payload as ScheduleCancelPayload;
      return `取消排程：${p.schedule_id}`;
    }
  }
}
