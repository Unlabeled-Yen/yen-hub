/**
 * Conversation persistence — localStorage for v0.
 * Migrates to SQLite (Tauri) or Turso (sync) in a later slice.
 *
 * Shape kept tiny and stable so the migration is mechanical.
 */

import type { UIMessage } from "ai";

export type Conversation = {
  id: string;
  title: string | null;
  messages: UIMessage[];
  createdAt: number;
  updatedAt: number;
};

const LIST_KEY = "yen-hub:conversations";
const ACTIVE_KEY = "yen-hub:active-conversation";

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function listConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  return safeParse<Conversation[]>(localStorage.getItem(LIST_KEY), []);
}

export function getConversation(id: string): Conversation | undefined {
  return listConversations().find((c) => c.id === id);
}

export function saveConversation(c: Conversation): void {
  if (typeof window === "undefined") return;
  const all = listConversations();
  const i = all.findIndex((x) => x.id === c.id);
  if (i >= 0) all[i] = c;
  else all.unshift(c);
  localStorage.setItem(LIST_KEY, JSON.stringify(all));
}

export function getActiveId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveId(id: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACTIVE_KEY, id);
}

export function createConversation(): Conversation {
  const id = crypto.randomUUID();
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
  const id = getActiveId();
  const existing = id ? getConversation(id) : undefined;
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
