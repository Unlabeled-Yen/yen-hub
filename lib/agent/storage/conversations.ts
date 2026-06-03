/**
 * Conversation store — JSON file at
 * `~/Library/Application Support/com.yen.hub/conversations.json`.
 *
 * Slice 8.7 (2026-06-03): moved from client-side localStorage to server-side
 * JSON because each .app launch picks a new ephemeral port → localStorage
 * is scoped per-origin → conversations were effectively lost on every
 * restart. Server-side persistence survives port churn.
 *
 * Migration path: when SQLite/Turso lands, swap the JSON read/write for
 * a real DB; call signatures stay the same.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "conversations.json");

export type Conversation = {
  id: string;
  title: string | null;
  messages: UIMessage[];
  createdAt: number;
  updatedAt: number;
};

type StoreShape = {
  conversations: Record<string, Conversation>;
  active_id: string | null;
};

let mem: StoreShape | null = null;

async function load(): Promise<StoreShape> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as StoreShape;
    // Backwards-compat for older shapes
    if (!mem.conversations) mem.conversations = {};
    if (mem.active_id === undefined) mem.active_id = null;
  } catch {
    mem = { conversations: {}, active_id: null };
  }
  return mem;
}

async function save(): Promise<void> {
  if (!mem) return;
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(mem, null, 2), "utf8");
  } catch {
    /* silent — overlay write failures don't take the app down */
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function listConversations(): Promise<Conversation[]> {
  const s = await load();
  return Object.values(s.conversations).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const s = await load();
  return s.conversations[id];
}

export async function saveConversation(c: Conversation): Promise<void> {
  const s = await load();
  s.conversations[c.id] = c;
  await save();
}

export async function deleteConversation(id: string): Promise<boolean> {
  const s = await load();
  if (!s.conversations[id]) return false;
  delete s.conversations[id];
  if (s.active_id === id) s.active_id = null;
  await save();
  return true;
}

export async function getActiveId(): Promise<string | null> {
  const s = await load();
  return s.active_id;
}

export async function setActiveId(id: string | null): Promise<void> {
  const s = await load();
  s.active_id = id;
  await save();
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
