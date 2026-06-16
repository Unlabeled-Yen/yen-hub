/**
 * Conversation persistence — client side wrapper around `/api/conversations`.
 *
 * Slice 8.7: moved from localStorage to server-side JSON because each .app
 * launch picks a new ephemeral port → localStorage was effectively wiped on
 * every restart. Server-side persistence survives port churn.
 *
 * Strategy:
 *   - Memory cache hydrates on first call (sync API stays for hot paths).
 *   - Writes go through API (`tokenFetch`); also update the cache.
 *   - `loadFromServer()` is what the chat UI calls on mount to bootstrap.
 *
 * Migration path: when the server moves to SQLite, this file doesn't change.
 */

import type { UIMessage } from "ai";
import { tokenFetch } from "@/lib/security/sidecar-token";

export type Conversation = {
  id: string;
  title: string | null;
  messages: UIMessage[];
  createdAt: number;
  updatedAt: number;
  /** Pinned conversations sort to the top. */
  pinned?: boolean;
  /** Group/folder name; null = ungrouped. */
  group?: string | null;
};

// In-memory cache, hydrated lazily.
let cache: Map<string, Conversation> = new Map();
let activeId: string | null = null;
let hydrated = false;
let hydrating: Promise<void> | null = null;

async function fetchAll(): Promise<void> {
  try {
    const [listRes, activeRes] = await Promise.all([
      tokenFetch("/api/conversations"),
      tokenFetch("/api/conversations/active"),
    ]);
    if (listRes.ok) {
      const data = (await listRes.json()) as { conversations: Conversation[] };
      cache = new Map(data.conversations.map((c) => [c.id, c]));
    }
    if (activeRes.ok) {
      const { active_id } = (await activeRes.json()) as {
        active_id: string | null;
      };
      activeId = active_id;
    }
  } catch {
    /* silent — first launch / network blip; cache stays empty */
  }
  hydrated = true;
}

/** Bootstrap the cache from server. Call once on chat mount. */
export async function loadFromServer(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) hydrating = fetchAll();
  await hydrating;
}

/* -------------------------------------------------------------------------- */
/*  Sync reads (cache only — call loadFromServer() first)                     */
/* -------------------------------------------------------------------------- */

export function listConversations(): Conversation[] {
  return Array.from(cache.values()).sort((a, b) => {
    // Pinned first, then most-recently-updated.
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** Distinct group names currently in use (sorted). */
export function listGroups(): string[] {
  const set = new Set<string>();
  for (const c of cache.values()) if (c.group) set.add(c.group);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Mutate one conversation's metadata + persist (without bumping updatedAt, so
 *  pinning/renaming/grouping doesn't reorder by recency). */
function patchConversation(id: string, patch: Partial<Conversation>): void {
  const c = cache.get(id);
  if (!c) return;
  saveConversation({ ...c, ...patch });
}

export function renameConversation(id: string, title: string): void {
  patchConversation(id, { title: title.trim() || null });
}

export function setPinned(id: string, pinned: boolean): void {
  patchConversation(id, { pinned });
}

export function setGroup(id: string, group: string | null): void {
  patchConversation(id, { group: group?.trim() || null });
}

export function getConversation(id: string): Conversation | undefined {
  return cache.get(id);
}

export function getActiveId(): string | null {
  return activeId;
}

/* -------------------------------------------------------------------------- */
/*  Writes — update cache immediately + fire request to server                */
/* -------------------------------------------------------------------------- */

export function saveConversation(c: Conversation): void {
  cache.set(c.id, c);
  // Fire-and-forget — chat UX shouldn't block on persistence.
  void tokenFetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(c),
  }).catch(() => {
    /* silent — next call will retry */
  });
}

export function setActiveId(id: string | null): void {
  activeId = id;
  void tokenFetch("/api/conversations/active", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => {
    /* silent */
  });
}

/** Permanently delete a conversation — drops it from the cache and the
 *  server JSON store (DELETE /api/conversations/[id]). If it was the active
 *  one, active is cleared. Irreversible. */
export async function deleteConversation(id: string): Promise<void> {
  cache.delete(id);
  if (activeId === id) activeId = null;
  try {
    await tokenFetch(`/api/conversations/${id}`, { method: "DELETE" });
  } catch {
    /* silent — cache already updated; next loadFromServer reconciles */
  }
}

export function createConversation(): Conversation {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `c_${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const now = Date.now();
  const c: Conversation = {
    id,
    title: null,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  saveConversation(c);
  setActiveId(id);
  return c;
}

export function ensureActive(): Conversation {
  const id = activeId;
  const existing = id ? cache.get(id) : undefined;
  return existing ?? createConversation();
}

/** Derive a readable title from the first user message. */
export function deriveTitle(messages: UIMessage[]): string | null {
  const first = messages.find((m) => m.role === "user");
  if (!first) return null;
  const text = first.parts
    ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (!text) return null;
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
