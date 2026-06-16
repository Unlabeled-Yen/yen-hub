#!/usr/bin/env node
/**
 * One-shot setup — create the daily 21:00 journal interview schedule.
 *
 * Phase 2a of the journal system. Writes directly to schedules.json so the
 * scheduler picks it up on next tick. Idempotent: if a schedule with
 * action_kind=journal_interview already exists, skips creation and reports.
 *
 * Run once after deploying the journal_interview action_kind. Keep the
 * script in-repo so it's documented and re-runnable on fresh installs.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE = join(
  homedir(),
  "Library",
  "Application Support",
  "com.yen.hub",
  "schedules.json",
);

function newId() {
  return "sch_" + crypto.randomUUID();
}

async function main() {
  let map = {};
  try {
    map = JSON.parse(await fs.readFile(STORE, "utf8"));
  } catch {
    /* fresh install — empty map is fine */
  }

  const existing = Object.values(map).find(
    (s) => s.action_kind === "journal_interview" && s.enabled !== false,
  );
  if (existing) {
    console.log(`已存在啟用中的 journal_interview 排程：${existing.name}`);
    console.log(`  id: ${existing.id}`);
    console.log(`  cron: ${existing.cron_expr}`);
    console.log("不再建立第二條。要改時間請編輯既有的，或 disable 後重跑。");
    return;
  }

  const now = Date.now();
  const id = newId();
  const schedule = {
    id,
    name: "每晚 21:00 日記訪談",
    cron_expr: "0 21 * * *",
    action_kind: "journal_interview",
    action_payload: {},
    enabled: true,
    created_at: now,
    created_by: "yen",
    source_intent: "manual-setup-script",
    fire_count: 0,
    rationale:
      "Phase 2a — 每晚 21:00 提示 Yen 開始 5 題日記訪談。觸發後在 Page B " +
      "出現 high-importance observation，Yen 打開 Duffy chat 說「開始日記訪談」即可。",
  };

  map[id] = schedule;

  const tmp = STORE + ".tmp-" + now;
  await fs.mkdir(join(STORE, ".."), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), "utf8");
  await fs.rename(tmp, STORE);

  console.log(`✅ 已建立排程：${schedule.name}`);
  console.log(`   id: ${id}`);
  console.log(`   cron: ${schedule.cron_expr}（每天 21:00）`);
  console.log("");
  console.log("下次 scheduler tick（≤ 60 秒內）會載入。今晚 21:00 起生效。");
  console.log("想改時間：到 Page B 的排程面板，或直接編輯 schedules.json。");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
