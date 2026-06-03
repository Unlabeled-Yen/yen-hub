/**
 * Inflight store — Slice 7.7.
 *
 * Tracks Duffy's "in-flight" response per conversation so that closing the
 * chat palette mid-stream doesn't lose the work. The LLM keeps running on
 * the server (runDuffy intentionally doesn't propagate the request's
 * AbortSignal to streamText); each text delta is appended here. When Yen
 * reopens the palette, the client fetches /api/chat/inflight and merges the
 * latest text into the conversation.
 *
 * One entry per conversation_id — overwrites on each new turn. Stale entries
 * (status="streaming" but no update for >5min) are treated as crashed and
 * reported as errored on next read.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "inflight.json");

/** A turn = one user message + Duffy's response. */
export type InflightTurn = {
  turnId: string;
  conversationId: string;
  text: string;
  status: "streaming" | "done" | "error";
  error?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
};

type Store = Record<string, InflightTurn>;

let mem: Store | null = null;
let pendingWrite: NodeJS.Timeout | null = null;

const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes without update → assume crashed

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
    /* silent — inflight is best-effort */
  }
}

/** Debounced flush so we don't fsync every token. */
function scheduleFlush(): void {
  if (pendingWrite) return;
  pendingWrite = setTimeout(() => {
    pendingWrite = null;
    void writeNow();
  }, 200);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function getInflight(
  conversationId: string,
): Promise<InflightTurn | null> {
  const m = await load();
  const entry = m[conversationId];
  if (!entry) return null;

  // Detect crashed-streaming entries — entry says "streaming" but no update
  // for ages → mark errored on read so client doesn't poll forever.
  if (
    entry.status === "streaming" &&
    Date.now() - entry.updatedAt > STALE_AFTER_MS
  ) {
    entry.status = "error";
    entry.error = `stale: no update for ${Math.round(
      (Date.now() - entry.updatedAt) / 1000,
    )}s`;
    entry.completedAt = Date.now();
    void writeNow();
  }

  return entry;
}

export async function startInflight(args: {
  conversationId: string;
  turnId: string;
}): Promise<void> {
  const m = await load();
  m[args.conversationId] = {
    turnId: args.turnId,
    conversationId: args.conversationId,
    text: "",
    status: "streaming",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writeNow(); // initial state lands immediately
}

export async function appendInflight(
  conversationId: string,
  delta: string,
): Promise<void> {
  if (!delta) return;
  const m = await load();
  const entry = m[conversationId];
  if (!entry || entry.status !== "streaming") return;
  entry.text += delta;
  entry.updatedAt = Date.now();
  scheduleFlush();
}

export async function finalizeInflight(args: {
  conversationId: string;
  status: "done" | "error";
  finalText?: string;
  error?: string;
}): Promise<void> {
  const m = await load();
  const entry = m[args.conversationId];
  if (!entry) return;
  if (args.finalText != null) entry.text = args.finalText;
  entry.status = args.status;
  if (args.error) entry.error = args.error;
  entry.completedAt = Date.now();
  entry.updatedAt = Date.now();
  await writeNow(); // final state lands immediately
}

/** Client calls this once it has consumed the entry. */
export async function clearInflight(conversationId: string): Promise<void> {
  const m = await load();
  if (m[conversationId]) {
    delete m[conversationId];
    await writeNow();
  }
}
