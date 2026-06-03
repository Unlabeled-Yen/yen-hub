/**
 * Summary store — weekly snapshots written by Duffy after Yen approves a
 * `summary` Intent.
 *
 * Lives at `~/Library/Application Support/com.yen.hub/summaries.json`.
 *
 * One entry per approved summary. Multiple summaries per ISO week are
 * allowed (e.g. Duffy re-summarises on demand) — `getCurrentWeekSummary`
 * returns the latest one for the current week.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Summary,
  type SummaryPayload,
  isoWeek,
  newSummaryId,
} from "./types";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "summaries.json");

type SummaryMap = Record<string, Summary>;

let mem: SummaryMap | null = null;

async function load(): Promise<SummaryMap> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as SummaryMap;
  } catch {
    mem = {};
  }
  return mem;
}

async function save(): Promise<void> {
  if (!mem) return;
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(mem, null, 2), "utf8");
  } catch {
    /* swallow */
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/** Newest summary for a given week, or null if none. */
export async function getSummaryByWeek(week: string): Promise<Summary | null> {
  const m = await load();
  const matches = Object.values(m).filter((s) => s.week === week);
  if (matches.length === 0) return null;
  return matches.reduce((latest, s) =>
    s.created_at > latest.created_at ? s : latest,
  );
}

/** Convenience for "this week". */
export async function getCurrentWeekSummary(): Promise<Summary | null> {
  return getSummaryByWeek(isoWeek());
}

/** Newest first, up to limit. */
export async function listSummaries(limit = 20): Promise<Summary[]> {
  const m = await load();
  return Object.values(m)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

export async function getSummary(id: string): Promise<Summary | undefined> {
  const m = await load();
  return m[id];
}

export async function createSummaryFromIntent(args: {
  intent_id: string;
  source_agent_id: string;
  payload: SummaryPayload;
}): Promise<Summary> {
  const m = await load();
  const sum: Summary = {
    id: newSummaryId(),
    week: args.payload.week,
    generated_at: Date.now(),
    headline: args.payload.headline,
    key_numbers: args.payload.key_numbers,
    pattern: args.payload.pattern,
    proposed_actions: args.payload.proposed_actions,
    source_observations: args.payload.source_observations,
    source_intent: args.intent_id,
    source_agent_id: args.source_agent_id,
    created_at: Date.now(),
  };
  m[sum.id] = sum;
  await save();
  return sum;
}

export async function _clearAll(): Promise<void> {
  mem = {};
  await save();
}

/* -------------------------------------------------------------------------- */
/*  Render helpers                                                             */
/* -------------------------------------------------------------------------- */

export function renderSummaryMarkdown(s: Summary): string {
  const generatedAt = new Date(s.created_at).toISOString();
  const nums = s.key_numbers
    .map((k) => `- **${k.label}**: ${k.value}${k.delta ? ` (${k.delta})` : ""}`)
    .join("\n");
  const actions = s.proposed_actions.map((a) => `- ${a}`).join("\n");
  return `---
name: ${s.week} 週摘要
week: ${s.week}
generated_at: ${generatedAt}
source_intent: ${s.source_intent}
---

# Headline

${s.headline}

# Key numbers

${nums}

# Pattern

${s.pattern}

# Proposed actions

${actions}
`;
}

export function renderSummaryForPrompt(s: Summary): string {
  const nums = s.key_numbers
    .map((k) => `${k.label}: ${k.value}${k.delta ? ` (${k.delta})` : ""}`)
    .join("; ");
  return `# Current week summary (${s.week})

**Headline**: ${s.headline}

**Numbers**: ${nums}

**Pattern**: ${s.pattern}`;
}
