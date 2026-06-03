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
  return Array.from(cache.values()).sort((a, b) => b.updatedAt - a.updatedAt);
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
