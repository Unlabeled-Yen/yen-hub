#!/usr/bin/env node
/**
 * SPEC-01 Step 4 — verify the JSON → SQLite migration.
 *
 * For each store that has a `<store>.json.migrated` rollback file (i.e. it
 * was actually migrated), compares its record count against the live SQLite
 * table row count, then deep-equals 3 sampled records — reconstructed from
 * SQL rows back into the original JSON shape — against the source records.
 * Exits non-zero on any mismatch. A store with no `.migrated` file yet is
 * reported as skipped, not failed (nothing to verify).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const DB_PATH = join(DIR, "yen-hub.db");

function reconstructObservation(row) {
  return {
    id: row.id,
    source_intent: row.source_intent,
    title: row.title,
    body: row.body,
    zone: row.zone ?? undefined,
    window: row.window_days != null ? { days: row.window_days } : undefined,
    evidence: JSON.parse(row.evidence),
    source: row.source,
    source_agent_id: row.source_agent_id ?? undefined,
    reason: row.reason,
    created_at: row.created_at,
    importance: row.importance,
    read_at: row.read_at ?? undefined,
    intention: row.intention ? JSON.parse(row.intention) : undefined,
    nudge_for: row.nudge_for ?? undefined,
    valid_until: row.valid_until ?? undefined,
    superseded_by: row.superseded_by ?? undefined,
    archived_at: row.archived_at ?? undefined,
  };
}

function reconstructIntent(row) {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    proposed_by: row.proposed_by,
    proposed_at: row.proposed_at,
    status: row.status,
    rationale: row.rationale,
    evidence: JSON.parse(row.evidence),
    importance: row.importance,
    decided_at: row.decided_at ?? undefined,
    decided_by: row.decided_by ?? undefined,
    resulted_in: row.resulted_in ?? undefined,
    trust_tier: row.trust_tier ?? undefined,
    undone_at: row.undone_at ?? undefined,
  };
}

function reconstructConversation(row) {
  return {
    id: row.id,
    title: row.title,
    messages: JSON.parse(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    group: row.grp,
  };
}

// Fields whose column carries a SQL DEFAULT — matches the fallbacks applied
// in observations.ts/intents.ts/conversations.ts for legacy records that
// predate the field. When a reconstructed value equals the field's default,
// drop it before comparing (from both sides) rather than requiring the
// original to have the exact same (possibly absent) key.
const FIELD_DEFAULTS = {
  importance: "medium",
  reason: "",
  rationale: "",
  pinned: false,
};

// Drop null/undefined top-level keys, plus any key whose value equals its
// known column default — the SQL round-trip materializes an absent
// optional/legacy column as that default, while the original JSON record
// may simply omit the key entirely. Nested JSON-blob fields (evidence,
// payload, intention, messages) are compared as-is: they're reproduced via
// JSON.parse(JSON.stringify(original)) so their internal shape is exact.
function normalize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (k in FIELD_DEFAULTS && v === FIELD_DEFAULTS[k]) continue;
    out[k] = v;
  }
  return out;
}

function pickSample(ids, n) {
  if (ids.length <= n) return ids;
  const step = Math.floor(ids.length / n);
  const out = [];
  for (let i = 0; i < ids.length && out.length < n; i += step) out.push(ids[i]);
  return out;
}

const STORES = [
  {
    name: "observations",
    table: "observations",
    legacy: join(DIR, "observations.json.migrated"),
    nested: false,
    reconstruct: reconstructObservation,
  },
  {
    name: "intents",
    table: "intents",
    legacy: join(DIR, "intents.json.migrated"),
    nested: false,
    reconstruct: reconstructIntent,
  },
  {
    name: "conversations",
    table: "conversations",
    legacy: join(DIR, "conversations.json.migrated"),
    nested: true, // legacy shape: { conversations: {...}, active_id }
    reconstruct: reconstructConversation,
  },
];

function main() {
  if (!existsSync(DB_PATH)) {
    console.log(`[verify] no DB at ${DB_PATH} — nothing migrated yet.`);
    return;
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let anyChecked = false;
  let failed = false;

  for (const store of STORES) {
    if (!existsSync(store.legacy)) {
      console.log(`[verify] ${store.name}: no ${store.legacy} — skipped (not migrated yet).`);
      continue;
    }
    anyChecked = true;

    const raw = readFileSync(store.legacy, "utf8");
    const parsed = JSON.parse(raw);
    const originalMap = store.nested ? (parsed.conversations ?? {}) : parsed;
    const originalEntries = Object.values(originalMap);

    const countRow = db.prepare(`SELECT COUNT(*) as c FROM ${store.table}`).get();
    if (countRow.c !== originalEntries.length) {
      console.error(
        `[verify] ${store.name}: COUNT MISMATCH — json=${originalEntries.length} table=${countRow.c}`,
      );
      failed = true;
      continue;
    }

    const ids = originalEntries.map((e) => e.id);
    const sampleIds = pickSample(ids, 3);
    let sampleOk = true;
    for (const id of sampleIds) {
      const original = originalMap[id];
      const row = db.prepare(`SELECT * FROM ${store.table} WHERE id = ?`).get(id);
      if (!row) {
        console.error(`[verify] ${store.name}: id ${id} missing from table`);
        sampleOk = false;
        continue;
      }
      const reconstructed = store.reconstruct(row);
      try {
        assert.deepStrictEqual(normalize(reconstructed), normalize(original));
      } catch (e) {
        console.error(`[verify] ${store.name}: sample mismatch on id ${id}`);
        console.error(e.message);
        sampleOk = false;
      }
    }

    if (sampleOk) {
      console.log(
        `[verify] ${store.name}: OK — ${countRow.c} row(s), ${sampleIds.length} sampled deep-equal`,
      );
    } else {
      failed = true;
    }
  }

  if (!anyChecked) {
    console.log("[verify] no *.json.migrated files found — nothing to verify yet.");
    return;
  }

  if (failed) {
    console.error("\n❌ verify FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ all migrated stores verified OK");
}

main();
