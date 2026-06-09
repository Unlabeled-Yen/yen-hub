/**
 * Intent materialisation — Slice 8.7B v2.
 *
 * Extracted from the decide route so the same logic runs in two paths:
 *   - HTTP approve  (user clicks "Yes 記下") — POST /api/intents/:id/decide
 *   - Auto-execute  (L0 intent under balanced/free trust mode) — inside
 *                   storage.createIntent right after persistence
 *
 * Side effects are kind-dispatched and identical to the pre-extraction
 * behavior. Failure modes return a structured error rather than throwing
 * (HTTP status code + message + optional extras for the response body).
 */

import { promises as fs } from "node:fs";
import { resolve, sep, dirname } from "node:path";
import { vaultPath } from "@/lib/vault/reader";
import {
  isObservationPayload,
  isSilhouetteUpdatePayload,
  isSummaryPayload,
  isFileCreatePayload,
  isFileEditPayload,
  isTodoPlanPayload,
  isScheduleCreatePayload,
  isScheduleCancelPayload,
  type Intent,
} from "@/lib/agent/storage/types";
import {
  createObservationFromIntent,
  touchIntention,
} from "@/lib/agent/storage/observations";
import { createSilhouetteFromIntent } from "@/lib/agent/storage/silhouettes";
import { createSummaryFromIntent } from "@/lib/agent/storage/summaries";
import {
  writeObservationToVault,
  writeSilhouetteToVault,
  writeSummaryToVault,
} from "@/lib/agent/vault-bridge";
import {
  createSchedule,
  setEnabled as setScheduleEnabled,
} from "@/lib/agent/storage/schedules";
import { parseCron, minIntervalMinutes } from "@/lib/agent/duffy/cron-utils";

export type MaterializeOk = {
  ok: true;
  resulted_in?: string;
  materialised: unknown;
};

export type MaterializeErr = {
  ok: false;
  error: {
    code: number; // HTTP status if surfaced from the decide route
    message: string;
    extra?: Record<string, unknown>;
  };
};

export type MaterializeResult = MaterializeOk | MaterializeErr;

export async function materializeIntent(
  intent: Intent,
): Promise<MaterializeResult> {
  if (isObservationPayload(intent)) {
    const obs = await createObservationFromIntent({
      intent_id: intent.id,
      title: intent.payload.title,
      body: intent.payload.body,
      zone: intent.payload.zone,
      window: intent.payload.window,
      evidence: intent.evidence,
      source_agent_id: intent.proposed_by,
      reason: intent.rationale,
      importance: intent.importance,
      intention: intent.payload.intention,
      nudge_for: intent.payload.nudge_for,
    });
    if (intent.payload.nudge_for) {
      await touchIntention(intent.payload.nudge_for);
    }
    await writeObservationToVault(obs);
    return {
      ok: true,
      resulted_in: obs.id,
      materialised: { kind: "observation", record: obs },
    };
  }

  if (isSilhouetteUpdatePayload(intent)) {
    const sil = await createSilhouetteFromIntent({
      intent_id: intent.id,
      source_agent_id: intent.proposed_by,
      reason: intent.rationale,
      payload: intent.payload,
    });
    await writeSilhouetteToVault(sil);
    return {
      ok: true,
      resulted_in: sil.id,
      materialised: { kind: "silhouette", record: sil },
    };
  }

  if (isSummaryPayload(intent)) {
    const sum = await createSummaryFromIntent({
      intent_id: intent.id,
      source_agent_id: intent.proposed_by,
      payload: intent.payload,
    });
    await writeSummaryToVault(sum);
    return {
      ok: true,
      resulted_in: sum.id,
      materialised: { kind: "summary", record: sum },
    };
  }

  if (isFileCreatePayload(intent)) {
    const root = vaultPath();
    const abs = resolve(root, intent.payload.path);
    if (!(abs === root || abs.startsWith(root + sep))) {
      return {
        ok: false,
        error: {
          code: 400,
          message: "path escapes vault",
          extra: { payload_path: intent.payload.path },
        },
      };
    }
    try {
      await fs.access(abs);
      return {
        ok: false,
        error: {
          code: 409,
          message: "file already exists; refusing to overwrite",
          extra: { path: intent.payload.path },
        },
      };
    } catch {
      /* file doesn't exist — good */
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = abs + ".tmp-" + Date.now();
    await fs.writeFile(tmp, intent.payload.content, "utf8");
    await fs.rename(tmp, abs);
    return {
      ok: true,
      materialised: { kind: "file_create", path: intent.payload.path },
    };
  }

  if (isFileEditPayload(intent)) {
    const root = vaultPath();
    const abs = resolve(root, intent.payload.path);
    if (!(abs === root || abs.startsWith(root + sep))) {
      return { ok: false, error: { code: 400, message: "path escapes vault" } };
    }
    let original: string;
    try {
      original = await fs.readFile(abs, "utf8");
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 404,
          message: `cannot read file: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
    const firstIdx = original.indexOf(intent.payload.old_text);
    const lastIdx = original.lastIndexOf(intent.payload.old_text);
    if (firstIdx === -1) {
      return {
        ok: false,
        error: { code: 422, message: "old_text not found in file" },
      };
    }
    if (firstIdx !== lastIdx) {
      return {
        ok: false,
        error: {
          code: 422,
          message: "old_text appears multiple times; ambiguous edit refused",
        },
      };
    }
    const updated =
      original.slice(0, firstIdx) +
      intent.payload.new_text +
      original.slice(firstIdx + intent.payload.old_text.length);
    await fs.writeFile(abs + ".bak", original, "utf8");
    const tmp = abs + ".tmp-" + Date.now();
    await fs.writeFile(tmp, updated, "utf8");
    await fs.rename(tmp, abs);
    return {
      ok: true,
      materialised: { kind: "file_edit", path: intent.payload.path },
    };
  }

  if (isTodoPlanPayload(intent)) {
    const root = vaultPath();
    const inboxRel = "05 - Queue/Duffy Todo Inbox.md";
    const abs = resolve(root, inboxRel);
    if (!(abs === root || abs.startsWith(root + sep))) {
      return { ok: false, error: { code: 400, message: "path escapes vault" } };
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    const stamp = new Date().toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const header = `\n\n## ${intent.payload.title}  · ${stamp}\n`;
    const lines = intent.payload.items
      .map((it) => `- [ ] ${it.text}${it.category ? ` _(${it.category})_` : ""}`)
      .join("\n");
    let prior = "";
    try {
      prior = await fs.readFile(abs, "utf8");
    } catch {
      prior =
        "# Duffy Todo Inbox\n\n_由 Duffy propose、Yen approve 後寫入。_\n";
    }
    await fs.writeFile(abs, prior + header + lines + "\n", "utf8");
    return {
      ok: true,
      materialised: {
        kind: "todo_plan",
        path: inboxRel,
        count: intent.payload.items.length,
      },
    };
  }

  if (isScheduleCreatePayload(intent)) {
    const p = intent.payload;
    let parsed;
    try {
      parsed = parseCron(p.cron_expr);
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 422,
          message: `invalid cron_expr: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
    // Keep in sync with schedule-tools.ts propose-side validation (15 min).
    if (minIntervalMinutes(parsed) < 15) {
      return {
        ok: false,
        error: {
          code: 422,
          message: "cron interval below 15 min minimum",
          extra: { cron_expr: p.cron_expr },
        },
      };
    }
    const sched = await createSchedule({
      intent_id: intent.id,
      created_by: intent.proposed_by,
      name: p.name,
      cron_expr: p.cron_expr,
      action_kind: p.action_kind,
      action_payload: p.action_payload,
      rationale: p.rationale,
      one_shot: p.one_shot,
      not_before: p.not_before,
    });
    return {
      ok: true,
      resulted_in: sched.id,
      materialised: { kind: "schedule_create", record: sched },
    };
  }

  if (isScheduleCancelPayload(intent)) {
    const p = intent.payload;
    const sched = await setScheduleEnabled(p.schedule_id, false);
    if (!sched) {
      return {
        ok: false,
        error: {
          code: 404,
          message: `schedule ${p.schedule_id} not found`,
        },
      };
    }
    return {
      ok: true,
      resulted_in: sched.id,
      materialised: { kind: "schedule_cancel", record: sched },
    };
  }

  // Should be unreachable — all IntentKinds covered above.
  return {
    ok: false,
    error: {
      code: 500,
      message: `unhandled intent kind: ${(intent as Intent).kind}`,
    },
  };
}
