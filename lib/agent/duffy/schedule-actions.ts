/**
 * Schedule actions — Slice 11.
 *
 * Each handler runs when the scheduler decides a Schedule is due. The
 * handler's job is NOT to mutate Yen's world directly — it's to surface
 * a finding (as an Observation or a propose-observation intent) so the
 * propose-approve flow stays in charge.
 *
 * v1 ships two action kinds. Two more (observation_review, custom_prompt)
 * land after Slice 8.7B trust-tier so they can be governed.
 */

import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { join } from "node:path";
import { createObservationFromIntent } from "@/lib/agent/storage/observations";
import { createIntent } from "@/lib/agent/storage/intents";
import { decideIntent } from "@/lib/agent/storage/intents";
import { vaultPath } from "@/lib/vault/reader";
import type {
  Schedule,
  ObservationPayload,
} from "@/lib/agent/storage/types";

const exec = promisify(execCb);

/** Common shape: each action records an observation about its finding. */
type Finding = {
  title: string;
  body: string;
  importance: "high" | "medium" | "low";
};

/* -------------------------------------------------------------------------- */
/*  git_unpushed_check                                                         */
/* -------------------------------------------------------------------------- */

type GitCheckPayload = { repos: string[] };

async function gitUnpushedCheck(
  s: Schedule,
): Promise<Finding | null> {
  const payload = s.action_payload as GitCheckPayload;
  if (!Array.isArray(payload.repos) || payload.repos.length === 0) return null;

  const lines: string[] = [];
  for (const repoRel of payload.repos) {
    // repoRel may be absolute or vault-relative or home-relative
    const repoPath = repoRel.startsWith("/")
      ? repoRel
      : repoRel.startsWith("~/")
        ? repoRel.replace(/^~/, process.env.HOME ?? "")
        : join(vaultPath(), "..", repoRel);
    try {
      const { stdout: branch } = await exec(
        `git -C "${repoPath}" rev-parse --abbrev-ref HEAD`,
      );
      const br = branch.trim();
      // Unpushed: commits ahead of upstream
      let ahead = "0";
      try {
        const { stdout: aheadOut } = await exec(
          `git -C "${repoPath}" rev-list --count @{u}..HEAD`,
        );
        ahead = aheadOut.trim();
      } catch {
        /* no upstream */
      }
      // Dirty: uncommitted changes
      const { stdout: status } = await exec(
        `git -C "${repoPath}" status --porcelain`,
      );
      const dirty = status.trim().split("\n").filter(Boolean).length;

      if (parseInt(ahead, 10) > 0 || dirty > 0) {
        lines.push(
          `- ${repoRel} (${br}) — 未推 ${ahead} commits, 未提交 ${dirty} 檔`,
        );
      }
    } catch (e) {
      lines.push(
        `- ${repoRel} — 檢查失敗: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (lines.length === 0) return null;
  return {
    title: `Git 未推 / 未提交檢查 (${lines.length} repos)`,
    body: lines.join("\n"),
    importance: "medium",
  };
}

/* -------------------------------------------------------------------------- */
/*  vault_zone_check                                                           */
/* -------------------------------------------------------------------------- */

type VaultZoneCheckPayload = { zone: string; days_idle: number };

async function vaultZoneCheck(s: Schedule): Promise<Finding | null> {
  const payload = s.action_payload as VaultZoneCheckPayload;
  if (!payload.zone || !payload.days_idle) return null;

  // Lazy import to avoid pulling heavy attention-data at module load
  const { buildAttention } = await import("@/lib/vault/attention-data");
  const data = await buildAttention(Math.max(payload.days_idle, 7));
  const zone = data.zones.find((z) => z.zone === payload.zone);

  if (!zone) {
    return {
      title: `${payload.zone} zone 找不到`,
      body: `排程設定 zone="${payload.zone}"、但 attention 資料裡沒有此 zone。可能該 zone 在這段期間完全沒動、或拼字錯誤。`,
      importance: "low",
    };
  }

  if (zone.added === 0 && zone.opened === 0) {
    return {
      title: `${payload.zone} zone 已 ${payload.days_idle} 天無活動`,
      body: `近 ${payload.days_idle} 天 ${payload.zone} 沒有新檔、也沒有開啟。是否需要回頭看看？`,
      importance: "medium",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  reminder — Slice 11.1                                                      */
/* -------------------------------------------------------------------------- */

type ReminderPayload = { message: string };

async function reminderAction(s: Schedule): Promise<Finding | null> {
  const payload = s.action_payload as ReminderPayload;
  const message = (payload?.message ?? "").trim();
  if (!message) return null;

  // 方向 2 收尾 — fire macOS notification in parallel. maybeNotify
  // checks the opt-in flag itself and never throws.
  try {
    const { maybeNotify } = await import("@/lib/agent/notifications");
    void maybeNotify({
      title: s.name,
      body: message,
      subtitle: "Duffy 提醒",
    });
  } catch {
    /* notifications are nice-to-have */
  }

  // Telegram integration — push to user's bot if enabled. Same opt-in
  // posture as macOS notifications.
  try {
    const { getTrustConfig } = await import("@/lib/agent/storage/trust-config");
    const { sendTelegram } = await import("@/lib/agent/telegram");
    const cfg = await getTrustConfig();
    if (cfg.telegram_enabled && cfg.telegram_bot_token && cfg.telegram_chat_id) {
      void sendTelegram({
        token: cfg.telegram_bot_token,
        chat_id: cfg.telegram_chat_id,
        text: `⏰ ${s.name}\n${message}`,
      });
    }
  } catch {
    /* nice-to-have */
  }

  return {
    title: s.name,
    body: message,
    importance: "high",
  };
}

/* -------------------------------------------------------------------------- */
/*  Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

const HANDLERS: Record<
  Schedule["action_kind"],
  (s: Schedule) => Promise<Finding | null>
> = {
  git_unpushed_check: gitUnpushedCheck,
  vault_zone_check: vaultZoneCheck,
  reminder: reminderAction,
};

/** Run the action, materialise findings as observations.
 *  Returns the resulting observation id (if any). */
export async function runScheduleAction(s: Schedule): Promise<string | null> {
  const handler = HANDLERS[s.action_kind];
  if (!handler) {
    console.warn(`[schedule-action] no handler for ${s.action_kind}`);
    return null;
  }

  let finding: Finding | null = null;
  try {
    finding = await handler(s);
  } catch (e) {
    console.error(
      `[schedule-action] ${s.id} (${s.action_kind}) threw:`,
      e,
    );
    return null;
  }
  if (!finding) return null;

  // Surface as a self-approved observation — schedules ARE the approval.
  //
  // 2026-06-09 fix: under Slice 8.7B v2 the global `createIntent` already
  // auto-materializes L0-tier observations under balanced/free trust mode
  // (calls materializeIntent → createObservationFromIntent internally).
  // The previous code then ALSO called createObservationFromIntent
  // explicitly, producing a duplicate observation every fire.
  //
  // Now we let createIntent do its thing, then:
  //   - if it auto-executed (mode=balanced/free + L0): use its resulted_in
  //   - if it didn't (mode=cautious): manually approve + materialise once
  // Either way, ONE observation per fire.
  const payload: ObservationPayload = {
    title: finding.title,
    body: finding.body,
  };
  const intent = await createIntent({
    kind: "observation",
    payload,
    proposed_by: "duffy-scheduler",
    rationale: `Auto-fired by schedule "${s.name}" (${s.action_kind})`,
    evidence: [],
    importance: finding.importance,
  });

  if (intent.status === "approved" && intent.resulted_in) {
    // Auto-execute path already materialised. Done.
    return intent.resulted_in;
  }

  // Manual path — trust mode = cautious, so createIntent left it pending.
  // Schedules ARE the user's prior approval, so we force-approve here.
  await decideIntent(intent.id, "approved");
  const obs = await createObservationFromIntent({
    intent_id: intent.id,
    title: payload.title,
    body: payload.body,
    evidence: [],
    source_agent_id: "duffy-scheduler",
    reason: intent.rationale,
    importance: finding.importance,
  });
  return obs.id;
}
