#!/usr/bin/env node
/**
 * One-shot recovery for the v1 → v4 silhouette wipeout (2026-06-03).
 *
 * v1 (2026-06-02) was Duffy's first real silhouette write — a paragraph
 * describing the 「實踐管家 / Phronetic Steward」 stance. A bad yen.md
 * vault-sync the next day overwrote it with 5 empty fields, then re-rendered
 * the empties back to yen.md, then re-parsed itself two more times,
 * cementing the garbage as v4.
 *
 * This script reads v1 directly out of silhouettes.json (it's still there,
 * just no longer the latest pointer) and writes its content as a new
 * version, restoring it as the current silhouette. The vault-sync.ts guard
 * added in the same commit prevents the wipeout from recurring.
 *
 * Run once. Idempotent: re-running just creates another version with the
 * same content, which the no-change check in any future sync will accept.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE = join(
  homedir(),
  "Library",
  "Application Support",
  "com.yen.hub",
  "silhouettes.json",
);

const V1_ID = "sil_b10d65fb-d2b8-4238-8faf-6d372455969e";

function newSilhouetteId() {
  // crypto.randomUUID is available in Node 19+; the app's storage uses it too.
  return "sil_" + crypto.randomUUID();
}

async function main() {
  const raw = await fs.readFile(STORE, "utf8");
  const map = JSON.parse(raw);

  const v1 = map[V1_ID];
  if (!v1) throw new Error(`v1 (${V1_ID}) not found in store`);

  // Find current max version so we slot in cleanly as max+1.
  const maxVersion = Object.values(map).reduce(
    (m, s) => Math.max(m, s.version ?? 0),
    0,
  );

  const restored = {
    id: newSilhouetteId(),
    version: maxVersion + 1,
    identity: v1.identity ?? "",
    style: v1.style ?? "",
    values: v1.values ?? "",
    boundaries: v1.boundaries ?? "",
    priorities: v1.priorities ?? "",
    confidence: v1.confidence ?? "medium",
    source_intent: "manual-restore",
    source_agent_id: "yen-script",
    reason: `從 v1（${V1_ID.slice(0, 14)}…）救回。中間 v2-v${maxVersion} 是 vault-sync bug 造成的空白雪崩。`,
    created_at: Date.now(),
  };

  map[restored.id] = restored;

  const tmp = STORE + ".tmp-" + Date.now();
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), "utf8");
  await fs.rename(tmp, STORE);

  console.log(`✅ 寫入 v${restored.version} (id: ${restored.id})`);
  console.log(`   identity:    ${restored.identity ? "有內容" : "(空)"}`);
  console.log(`   style:       ${restored.style.length} 字`);
  console.log(`   values:      ${restored.values ? "有內容" : "(空)"}`);
  console.log(`   boundaries:  ${restored.boundaries ? "有內容" : "(空)"}`);
  console.log(`   priorities:  ${restored.priorities ? "有內容" : "(空)"}`);
  console.log(`\n下一步：在 Yen.app 重開剪影面板（會自動讀 v${restored.version}），`);
  console.log(`        確認看起來對，再用面板上的「同步到 vault」按鈕（如果有）`);
  console.log(`        或讓下次 Duffy 的 silhouette_update 自然重生 yen.md。`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
