/**
 * Pending Skill Session — Slice 14 (skill-anchored reminders).
 *
 * Marks a chat as "waiting for the user to confirm starting a skill flow".
 * Set when a schedule fires with ask_first semantics (e.g. journal_interview).
 * Cleared when:
 *   - user replies affirmatively → skill flow starts
 *   - user defers → marker dropped (may re-schedule)
 *   - TTL expires → marker self-clears
 *
 * Why a separate store: we can't piggy-back on the conversation history
 * because Duffy's free-form reply would happen BEFORE we check intent. The
 * marker is the structural "is there a pending skill?" answer the poller
 * needs at message-arrival time — Duffy is bypassed in that window.
 *
 * See: lib/agent/duffy/inflight-store.ts (similar file-backed pattern).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "pending-skill-session.json");

/** v0 — only journal_interview supported. Add new skills as the system grows. */
export type SkillName = "journal_interview";

export type PendingSkillSession = {
  chatId: number;
  skill: SkillName;
  promptedAt: number;
  expiresAt: number;
  source: "scheduler" | "manual";
  scheduleId?: string;
  /** Extra context the skill flow may need at start-time. */
  context?: Record<string, unknown>;
};

type Store = Record<string, PendingSkillSession>; // keyed by chatId (string)

let mem: Store | null = null;

async function load(): Promise<Store> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as Store;
  } catch {
    mem = {};
  }
  return mem;
}

async function writeNow(): Promise<void> {
  if (!mem) return;
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(mem, null, 2), "utf8");
  } catch {
    /* silent — pending-skill is best-effort */
  }
}

/** Default TTL: 30 minutes. After that, the affirmative "好" no longer
 *  triggers the skill flow — Yen would have to say "開始日記訪談" explicitly. */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function setPendingSkillSession(
  args: Omit<PendingSkillSession, "promptedAt" | "expiresAt"> & {
    ttlMs?: number;
  },
): Promise<void> {
  const m = await load();
  const now = Date.now();
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
  m[String(args.chatId)] = {
    chatId: args.chatId,
    skill: args.skill,
    source: args.source,
    scheduleId: args.scheduleId,
    context: args.context,
    promptedAt: now,
    expiresAt: now + ttl,
  };
  await writeNow();
}

export async function getPendingSkillSession(
  chatId: number,
): Promise<PendingSkillSession | null> {
  const m = await load();
  const entry = m[String(chatId)];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    delete m[String(chatId)];
    await writeNow();
    return null;
  }
  return entry;
}

export async function clearPendingSkillSession(chatId: number): Promise<void> {
  const m = await load();
  if (m[String(chatId)]) {
    delete m[String(chatId)];
    await writeNow();
  }
}
