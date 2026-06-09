/**
 * Token usage log — Slice 元能力 #1.
 *
 * Append-only JSONL of every LLM call's reported `usage`, tagged with
 * call-site so we can see where the budget is going. Used by:
 *   - /api/token-usage   — today / N-day rollup for the UI
 *   - trust-config       — daily_token_budget enforcement (soft warning
 *                          in v1; hard cutoff a possible v2)
 *
 * Same on-disk pattern as trust-signals.jsonl: append O(1), read newest-
 * first, rotate at 10MB. Records are tiny so rotation rarely fires.
 *
 * Schema is deliberately permissive about `usage` shape — Vercel AI SDK's
 * usage object varies slightly by provider (Anthropic exposes
 * inputTokens/outputTokens/totalTokens; OpenAI uses different keys). We
 * normalise into a single { input, output, total } at write time.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "token-usage.jsonl");
const OLD_FILE = FILE + ".old";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_READ_LINES = 5000;

export type CallSite =
  | "duffy-chat"           // agent.ts streamText
  | "coach-card"           // coach.ts
  | "summary-cron"         // summary-cron.ts
  | "headless-telegram"    // headless.ts (Telegram surface)
  | "nudge-draft"          // stale-intentions.ts
  | "bootstrap"            // bootstrap.ts (silhouette init)
  | "other";

export type TokenUsageRecord = {
  ts: number;
  call_site: CallSite;
  model: string;
  input: number;
  output: number;
  total: number;
  /** Optional context tag — turn id, conversation id, schedule id, etc. */
  ref?: string;
};

/** Vercel AI SDK returns usage with provider-specific keys. Normalise. */
export function normalizeUsage(raw: unknown): {
  input: number;
  output: number;
  total: number;
} {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  // Anthropic / new AI SDK: inputTokens / outputTokens / totalTokens
  // Older SDK / OpenAI: promptTokens / completionTokens / totalTokens
  const input = num(u.inputTokens) || num(u.promptTokens) || 0;
  const output = num(u.outputTokens) || num(u.completionTokens) || 0;
  const total = num(u.totalTokens) || input + output;
  return { input, output, total };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const stat = await fs.stat(FILE);
    if (stat.size > MAX_FILE_BYTES) {
      await fs.rename(FILE, OLD_FILE).catch(() => {});
    }
  } catch {
    /* not yet created */
  }
}

/** Best-effort append. Never throws — token logging is observability,
 *  must not break the actual LLM call. */
export async function recordTokenUsage(args: {
  call_site: CallSite;
  model: string;
  usage: unknown;
  ref?: string;
}): Promise<void> {
  try {
    const { input, output, total } = normalizeUsage(args.usage);
    if (total === 0) return; // nothing to record
    const rec: TokenUsageRecord = {
      ts: Date.now(),
      call_site: args.call_site,
      model: args.model,
      input,
      output,
      total,
      ref: args.ref,
    };
    await ensureDir();
    await rotateIfNeeded();
    await fs.appendFile(FILE, JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    console.warn("[token-usage] append failed:", e);
  }
}

/* -------------------------------------------------------------------------- */
/*  Read + aggregate                                                           */
/* -------------------------------------------------------------------------- */

async function readRecentRaw(maxLines: number): Promise<TokenUsageRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const out: TokenUsageRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as TokenUsageRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

export type UsageRollup = {
  total: number;
  input: number;
  output: number;
  by_call_site: Record<string, number>;
  by_model: Record<string, number>;
  count: number;
};

function emptyRollup(): UsageRollup {
  return {
    total: 0,
    input: 0,
    output: 0,
    by_call_site: {},
    by_model: {},
    count: 0,
  };
}

function accumulate(acc: UsageRollup, r: TokenUsageRecord): void {
  acc.total += r.total;
  acc.input += r.input;
  acc.output += r.output;
  acc.by_call_site[r.call_site] =
    (acc.by_call_site[r.call_site] ?? 0) + r.total;
  acc.by_model[r.model] = (acc.by_model[r.model] ?? 0) + r.total;
  acc.count += 1;
}

/** Local-date rollup. `date` is a YYYY-MM-DD string or omitted = today. */
export async function rollupForDate(date?: string): Promise<UsageRollup> {
  const target = date ?? new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  const recs = await readRecentRaw(MAX_READ_LINES);
  const acc = emptyRollup();
  for (const r of recs) {
    const d = new Date(r.ts).toLocaleDateString("en-CA");
    if (d === target) accumulate(acc, r);
  }
  return acc;
}

/** Window rollup — last N days (inclusive of today). */
export async function rollupWindow(days: number): Promise<UsageRollup> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recs = await readRecentRaw(MAX_READ_LINES);
  const acc = emptyRollup();
  for (const r of recs) {
    if (r.ts >= cutoff) accumulate(acc, r);
  }
  return acc;
}
