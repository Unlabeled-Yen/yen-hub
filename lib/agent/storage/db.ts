/**
 * SQLite backing store — `~/Library/Application Support/com.yen.hub/yen-hub.db`.
 *
 * See docs/specs/SPEC-01-sqlite-migration.md. `node:sqlite` (Node built-in,
 * 22.13+) instead of better-sqlite3: the bundled sidecar Node is v22.22.0, and
 * a built-in module means zero native addon — prep-sidecar.sh / Next
 * standalone packaging is untouched.
 *
 * Lazy singleton: `getDb()` opens the file, applies PRAGMAs, and runs the
 * (idempotent) schema DDL on first call. Safe to call from any module; two
 * bundled instances (API routes vs instrumentation.ts) each get their own
 * `DatabaseSync` handle onto the same WAL-mode file, which is the same
 * cross-instance shape the JSON stores already lived with (see
 * atomic-write.ts) — WAL + busy_timeout make concurrent connections safe.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const DB_PATH = join(DIR, "yen-hub.db");

const SCHEMA_VERSION = "1";

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id             TEXT PRIMARY KEY,
  source_intent  TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  zone           TEXT,
  window_days    INTEGER,
  evidence       TEXT NOT NULL DEFAULT '[]',
  source         TEXT NOT NULL,
  source_agent_id TEXT,
  reason         TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  importance     TEXT NOT NULL DEFAULT 'medium',
  read_at        INTEGER,
  intention      TEXT,
  nudge_for      TEXT,
  valid_until    INTEGER,
  superseded_by  TEXT,
  archived_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_unread_high
  ON observations(created_at) WHERE read_at IS NULL AND importance = 'high';

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  rationale   TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '[]',
  importance  TEXT NOT NULL DEFAULT 'medium',
  decided_at  INTEGER,
  decided_by  TEXT,
  resulted_in TEXT,
  trust_tier  TEXT,
  undone_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status, proposed_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  messages   TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  grp        TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
`;

let db: DatabaseSync | null = null;

/** Lazy singleton — opens the DB, applies PRAGMAs, and runs schema DDL on first call. */
export function getDb(): DatabaseSync {
  if (db) return db;

  mkdirSync(DIR, { recursive: true });
  const handle = new DatabaseSync(DB_PATH);
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec("PRAGMA busy_timeout = 5000;");
  handle.exec("PRAGMA foreign_keys = ON;");
  handle.exec(SCHEMA_DDL);

  const row = handle
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (!row) {
    handle
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(SCHEMA_VERSION);
  }

  db = handle;
  return db;
}

/**
 * D5 — one-time JSON → SQLite import for a store. No-op if `table` already
 * has rows, or `jsonPath` doesn't exist (nothing to import / already
 * migrated). Runs inserts in a single transaction, verifies the post-import
 * row count against the entry count (throws on mismatch — a failed startup
 * beats a silent data loss), then renames the source file to `<path>.migrated`
 * (never deletes — that's the rollback point per SPEC-01 D5).
 */
export function importJsonOnce(opts: {
  table: string;
  jsonPath: string;
  columns: string[];
  /** Parse the raw JSON file content into a list of source records. */
  parseEntries: (raw: string) => unknown[];
  /** Map one source record into column values, in the same order as `columns`. */
  mapRow: (entry: unknown) => unknown[];
}): void {
  const database = getDb();

  const existing = database
    .prepare(`SELECT COUNT(*) as c FROM ${opts.table}`)
    .get() as { c: number };
  if (existing.c > 0) return;
  if (!existsSync(opts.jsonPath)) return;

  const raw = readFileSync(opts.jsonPath, "utf8");
  const entries = opts.parseEntries(raw);

  const placeholders = opts.columns.map(() => "?").join(", ");
  const insert = database.prepare(
    `INSERT INTO ${opts.table} (${opts.columns.join(", ")}) VALUES (${placeholders})`,
  );

  database.exec("BEGIN");
  try {
    for (const entry of entries) {
      insert.run(...(opts.mapRow(entry) as (string | number | null)[]));
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }

  const after = database
    .prepare(`SELECT COUNT(*) as c FROM ${opts.table}`)
    .get() as { c: number };
  if (after.c !== entries.length) {
    throw new Error(
      `[db] import mismatch for ${opts.table}: expected ${entries.length} rows from ${opts.jsonPath}, got ${after.c}`,
    );
  }

  renameSync(opts.jsonPath, `${opts.jsonPath}.migrated`);
}
