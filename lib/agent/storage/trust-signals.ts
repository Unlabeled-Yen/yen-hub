/**
 * Trust signal log — Slice 12 Phase 2.
 *
 * Append-only JSONL at ~/Library/Application Support/com.yen.hub/
 * trust-signals.jsonl. Each decision (user approve/reject, auto-execute,
 * undo) writes one line. Phase 3's "Suggest tier" banner reads these to
 * derive per-kind/per-feature approve rates.
 *
 * Why JSONL not JSON: append-only is O(1) regardless of file size. Reads
 * stream-parse line by line; we cap each read at 1000 most-recent lines.
 *
 * Rotation: when file exceeds 50MB, rename to .old (keeping one
 * generation). Trust-signal data has no archival value beyond 1-2 months;
 * older lines fall off naturally.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Intent,
  IntentKind,
  Importance,
  TrustTier,
} from "./types";
import { extractFeatures, type PayloadFeatures } from "./trust-features";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "trust-signals.jsonl");
const OLD_FILE = FILE + ".old";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_READ_LINES = 1000;

export type TrustDecision =
  | "approved"        // user pressed Yes
  | "rejected"        // user pressed No
  | "auto_approved"   // L0 + balanced/free, materialised at create time
  | "auto_undone";    // user clicked Undo on an auto-executed intent

export type TrustSignal = {
  ts: number;
  intent_id: string;
  kind: IntentKind;
  proposed_by: string;
  importance: Importance;
  trust_tier_at_decision: TrustTier;
  payload_features: PayloadFeatures;
  decision: TrustDecision;
  decided_by: "user" | "auto";
};

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
    /* file doesn't exist yet — nothing to rotate */
  }
}

/** Append a signal. Best-effort: write failures are logged, never thrown. */
export async function appendSignal(sig: TrustSignal): Promise<void> {
  try {
    await ensureDir();
    await rotateIfNeeded();
    const line = JSON.stringify(sig) + "\n";
    await fs.appendFile(FILE, line, "utf8");
  } catch (e) {
    console.warn("[trust-signals] append failed:", e);
  }
}

/** Build a TrustSignal from an Intent + decision, then append. */
export async function recordDecision(args: {
  intent: Intent;
  decision: TrustDecision;
  decided_by: "user" | "auto";
}): Promise<void> {
  const sig: TrustSignal = {
    ts: Date.now(),
    intent_id: args.intent.id,
    kind: args.intent.kind,
    proposed_by: args.intent.proposed_by,
    importance: args.intent.importance,
    trust_tier_at_decision: args.intent.trust_tier ?? "L1",
    payload_features: extractFeatures(args.intent),
    decision: args.decision,
    decided_by: args.decided_by,
  };
  await appendSignal(sig);
}

/* -------------------------------------------------------------------------- */
/*  Read path — used by API + future banner                                    */
/* -------------------------------------------------------------------------- */

/** Read up to MAX_READ_LINES most-recent signals, optionally filtered. */
export async function readRecentSignals(opts?: {
  since?: number; // ms epoch
  kind?: IntentKind;
}): Promise<TrustSignal[]> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const out: TrustSignal[] = [];
  // Walk from end backwards — newest first, stop at limit.
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_READ_LINES; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const sig = JSON.parse(line) as TrustSignal;
      if (opts?.since && sig.ts < opts.since) continue;
      if (opts?.kind && sig.kind !== opts.kind) continue;
      out.push(sig);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Stats — group + counts for Phase 3 banner                                  */
/* -------------------------------------------------------------------------- */

export type GroupKey = string; // canonical "kind=X|by=Y"

export type GroupStat = {
  key: GroupKey;
  kind: IntentKind;
  proposed_by: string;
  approved: number;
  rejected: number;
  auto_approved: number;
  auto_undone: number;
  total_decided: number;       // approved + rejected + auto_approved
  approve_rate: number;        // (approved + auto_approved) / total_decided
};

export async function statsByKindAndProposer(opts?: {
  since?: number;
}): Promise<GroupStat[]> {
  const sigs = await readRecentSignals({ since: opts?.since });
  const buckets = new Map<GroupKey, GroupStat>();

  for (const s of sigs) {
    const key = `kind=${s.kind}|by=${s.proposed_by}`;
    let g = buckets.get(key);
    if (!g) {
      g = {
        key,
        kind: s.kind,
        proposed_by: s.proposed_by,
        approved: 0,
        rejected: 0,
        auto_approved: 0,
        auto_undone: 0,
        total_decided: 0,
        approve_rate: 0,
      };
      buckets.set(key, g);
    }
    switch (s.decision) {
      case "approved":
        g.approved++;
        g.total_decided++;
        break;
      case "rejected":
        g.rejected++;
        g.total_decided++;
        break;
      case "auto_approved":
        g.auto_approved++;
        g.total_decided++;
        break;
      case "auto_undone":
        g.auto_undone++;
        // Note: auto_undone doesn't increment total_decided — its sibling
        // auto_approved already did. Undone is a corrective signal counted
        // separately for "trust drift" warnings.
        break;
    }
  }

  for (const g of buckets.values()) {
    g.approve_rate =
      g.total_decided > 0
        ? (g.approved + g.auto_approved) / g.total_decided
        : 0;
  }

  return Array.from(buckets.values()).sort(
    (a, b) => b.total_decided - a.total_decided,
  );
}
