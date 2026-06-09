/**
 * Trust-signal feature extraction — Slice 12 Phase 2.
 *
 * Pure: takes an Intent, returns a feature object suitable for grouping
 * trust signals. v1 is intentionally minimal — only fields that are cheap
 * to compute and likely to matter for "should this auto-approve" learning.
 *
 * When Phase 3 banners show "你過去 N 條 observation 通過 X 條", the
 * grouping key is { kind, proposed_by }. Other features go along for the
 * ride so later analysis can slice deeper without re-running.
 */

import type {
  Intent,
  ObservationPayload,
  FileCreatePayload,
  FileEditPayload,
  TodoPlanPayload,
} from "./types";

export type PayloadFeatures = {
  has_evidence: boolean;
  /** Observation-specific: nudge cards usually reflect stale intentions —
   *  Yen tends to engage them differently from fresh observations. */
  has_nudge: boolean;
  /** Rough size proxy. Strings are summed; objects → JSON.stringify length.
   *  Useful for catching "Duffy proposes giant edits I reject" patterns. */
  payload_size: number;
};

export function extractFeatures(intent: Intent): PayloadFeatures {
  const has_evidence = intent.evidence.length > 0;

  let has_nudge = false;
  let payload_size = 0;

  switch (intent.kind) {
    case "observation": {
      const p = intent.payload as ObservationPayload;
      has_nudge = Boolean(p.nudge_for);
      payload_size = (p.title?.length ?? 0) + (p.body?.length ?? 0);
      break;
    }
    case "file_create": {
      const p = intent.payload as FileCreatePayload;
      payload_size = (p.path?.length ?? 0) + (p.content?.length ?? 0);
      break;
    }
    case "file_edit": {
      const p = intent.payload as FileEditPayload;
      payload_size =
        (p.old_text?.length ?? 0) +
        (p.new_text?.length ?? 0) +
        (p.path?.length ?? 0);
      break;
    }
    case "todo_plan": {
      const p = intent.payload as TodoPlanPayload;
      payload_size =
        (p.title?.length ?? 0) +
        p.items.reduce((acc, it) => acc + (it.text?.length ?? 0), 0);
      break;
    }
    default:
      try {
        payload_size = JSON.stringify(intent.payload).length;
      } catch {
        payload_size = 0;
      }
  }

  return { has_evidence, has_nudge, payload_size };
}
