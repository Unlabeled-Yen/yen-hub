/**
 * Conversation store — SQLite table `conversations` in
 * `~/Library/Application Support/com.yen.hub/yen-hub.db`. `active_id` lives
 * in the shared `meta` table (key `active_id`) per SPEC-01 D3.
 *
 * SPEC-01 (2026-07) — migrated off the conversations.json overlay. Public API
 * signatures are unchanged. `group` (a reserved word in SQL) is stored as
 * column `grp`; the public `Conversation.group` field name is untouched.
 *
 * One-time import is bespoke here (not `importJsonOnce` from db.ts) because
 * the legacy file holds two destinations — the conversations map AND
 * `active_id` — where the generic helper assumes one table per file. Same D5
 * contract: single transaction, post-import count check that throws on
 * mismatch, rename (never delete) the source file as the rollback point.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { getDb } from "./db";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const LEGACY_JSON = join(DIR, "conversations.json");

export type Conversation = {
  id: string;
  title: string | null;
  messages: UIMessage[];
  createdAt: number;
  updatedAt: number;
  /** Pinned conversations sort to the top of the list. */
  pinned?: boolean;
  /** Optional group/folder name; null/undefined = ungrouped. */
  group?: string | null;
};

type ConversationRow = {
  id: string;
  title: string | null;
  messages: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  grp: string | null;
};

type LegacyStoreShape = {
  conversations: Record<string, Conversation>;
  active_id: string | null;
};

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    messages: JSON.parse(row.messages) as UIMessage[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    group: row.grp,
  };
}

function conversationToRow(c: Conversation): (string | number | null)[] {
  return [
    c.id,
    c.title,
    JSON.stringify(c.messages ?? []),
    c.createdAt,
    c.updatedAt,
    c.pinned ? 1 : 0,
    c.group ?? null,
  ];
}

let migrated = false;
function ensureMigrated(): void {
  if (migrated) return;
  // Only latch on success — a failed import must be retryable on the next
  // call within this process, not stuck until restart.

  const database = getDb();
  const existing = database
    .prepare("SELECT COUNT(*) as c FROM conversations")
    .get() as { c: number };
  if (existing.c > 0) {
    migrated = true;
    return;
  }
  if (!existsSync(LEGACY_JSON)) {
    migrated = true;
    return;
  }

  const raw = readFileSync(LEGACY_JSON, "utf8");
  const parsed = JSON.parse(raw) as Partial<LegacyStoreShape>;
  const entries = Object.values(parsed.conversations ?? {});

  const insert = database.prepare(
    "INSERT INTO conversations (id, title, messages, created_at, updated_at, pinned, grp) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  database.exec("BEGIN");
  try {
    for (const c of entries) insert.run(...conversationToRow(c));
    if (parsed.active_id != null) {
      database
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_id', ?)")
        .run(parsed.active_id);
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }

  const after = database
    .prepare("SELECT COUNT(*) as c FROM conversations")
    .get() as { c: number };
  if (after.c !== entries.length) {
    throw new Error(
      `[conversations] import mismatch: expected ${entries.length} rows from ${LEGACY_JSON}, got ${after.c}`,
    );
  }

  renameSync(LEGACY_JSON, `${LEGACY_JSON}.migrated`);
  migrated = true;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function listConversations(): Promise<Conversation[]> {
  ensureMigrated();
  const database = getDb();
  const rows = database
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
    .all() as unknown as ConversationRow[];
  return rows.map(rowToConversation);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as ConversationRow | undefined;
  return row ? rowToConversation(row) : undefined;
}

export async function saveConversation(c: Conversation): Promise<void> {
  ensureMigrated();
  const database = getDb();
  database
    .prepare(
      `INSERT INTO conversations (id, title, messages, created_at, updated_at, pinned, grp)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         messages = excluded.messages,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         pinned = excluded.pinned,
         grp = excluded.grp`,
    )
    .run(...conversationToRow(c));
}

export async function deleteConversation(id: string): Promise<boolean> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT id FROM conversations WHERE id = ?")
    .get(id) as { id: string } | undefined;
  if (!row) return false;
  database.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  const active = database
    .prepare("SELECT value FROM meta WHERE key = 'active_id'")
    .get() as { value: string } | undefined;
  if (active?.value === id) {
    database
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_id', NULL)")
      .run();
  }
  return true;
}

export async function getActiveId(): Promise<string | null> {
  ensureMigrated();
  const database = getDb();
  const row = database
    .prepare("SELECT value FROM meta WHERE key = 'active_id'")
    .get() as { value: string | null } | undefined;
  return row?.value ?? null;
}

export async function setActiveId(id: string | null): Promise<void> {
  ensureMigrated();
  const database = getDb();
  database
    .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_id', ?)")
    .run(id);
}

/* -------------------------------------------------------------------------- */
/*  Search — for Duffy's read_conversation_history tool                       */
/* -------------------------------------------------------------------------- */

function flattenMessageText(m: UIMessage): string {
  const parts = m.parts ?? [];
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

export type ConversationSearchHit = {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
  /** Snippet around the match (or first line if no query). */
  snippet: string;
  matchedRole?: "user" | "assistant";
};

export async function searchConversations(opts: {
  query?: string;
  sinceDays?: number;
  limit?: number;
}): Promise<ConversationSearchHit[]> {
  const all = await listConversations();
  const limit = Math.min(opts.limit ?? 15, 50);
  const sinceMs = opts.sinceDays
    ? Date.now() - opts.sinceDays * 86_400_000
    : 0;
  const q = (opts.query ?? "").toLowerCase().trim();

  const out: ConversationSearchHit[] = [];
  for (const c of all) {
    if (c.updatedAt < sinceMs) continue;
    if (!q) {
      const firstUser = c.messages.find((m) => m.role === "user");
      out.push({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        snippet: firstUser
          ? flattenMessageText(firstUser).slice(0, 200)
          : "(empty)",
      });
    } else {
      // find first matching message
      let hit: { text: string; role: "user" | "assistant" } | null = null;
      for (const m of c.messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        const text = flattenMessageText(m);
        if (text.toLowerCase().includes(q)) {
          hit = { text, role: m.role as "user" | "assistant" };
          break;
        }
      }
      if (!hit) continue;
      const idx = hit.text.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 80);
      const end = Math.min(hit.text.length, idx + q.length + 160);
      out.push({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        snippet:
          (start > 0 ? "…" : "") +
          hit.text.slice(start, end).replace(/\s+/g, " ").trim() +
          (end < hit.text.length ? "…" : ""),
        matchedRole: hit.role,
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}
