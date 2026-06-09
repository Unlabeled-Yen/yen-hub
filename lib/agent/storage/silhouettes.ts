/**
 * Silhouette store — Duffy's portrait of Yen.
 *
 * Lives at `~/Library/Application Support/com.yen.hub/silhouettes.json`.
 * Holds the full version history; the "current" silhouette is the one with
 * the highest version number.
 *
 * Slice 7A: silhouette is a 5-field SOUL.md-style document (Identity / Style
 * / Values / Boundaries / Priorities). Versioned monotonically. Each new
 * version comes from an approved `silhouette_update` Intent (full or partial
 * field replacement).
 *
 * Sibling shape to intents.ts / observations.ts so the future SQLite migration
 * is uniform.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Silhouette,
  type SilhouetteField,
  type SilhouetteUpdatePayload,
  newSilhouetteId,
} from "./types";

const VAULT_SYNC_INTENT_ID = "vault-sync";
const VAULT_SYNC_AGENT_ID = "user-vault-edit";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "silhouettes.json");

type SilhouetteMap = Record<string, Silhouette>;

let mem: SilhouetteMap | null = null;

// Always re-read from disk — no forever-cache. Real bug (2026-06-10, see
// schedules.ts): in Next standalone, API routes and instrumentation.ts
// bundle SEPARATE instances of this module. Silhouettes are written from
// the cron side (intent-materialize, vault-sync) and read from routes
// (/api/silhouette). A boot-time cache lets each side silently miss the
// other's writes until restart.
async function load(): Promise<SilhouetteMap> {
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as SilhouetteMap;
  } catch {
    mem = mem ?? {};
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

/** The highest-version silhouette, or null if none exists (pre-bootstrap). */
export async function getCurrentSilhouette(): Promise<Silhouette | null> {
  const m = await load();
  const all = Object.values(m);
  if (all.length === 0) return null;
  return all.reduce((max, s) => (s.version > max.version ? s : max));
}

export async function getSilhouette(id: string): Promise<Silhouette | undefined> {
  const m = await load();
  return m[id];
}

/** All versions, newest first. */
export async function listSilhouetteHistory(): Promise<Silhouette[]> {
  const m = await load();
  return Object.values(m).sort((a, b) => b.version - a.version);
}

/**
 * Materialise a silhouette from an approved `silhouette_update` intent.
 *
 * - `field === "full"` → `new_value` is a JSON-stringified object with all 5
 *   fields. Used by bootstrap and full rewrites.
 * - else → replaces just that field; other 4 inherit from the current
 *   silhouette (must exist).
 *
 * Version is `(current?.version ?? 0) + 1`.
 */
export async function createSilhouetteFromIntent(args: {
  intent_id: string;
  source_agent_id: string;
  reason: string;
  payload: SilhouetteUpdatePayload;
}): Promise<Silhouette> {
  const m = await load();
  const current = await getCurrentSilhouette();
  const nextVersion = (current?.version ?? 0) + 1;

  let identity = current?.identity ?? "";
  let style = current?.style ?? "";
  let values = current?.values ?? "";
  let boundaries = current?.boundaries ?? "";
  let priorities = current?.priorities ?? "";

  if (args.payload.field === "full") {
    const parsed = JSON.parse(args.payload.new_value) as Partial<{
      identity: string;
      style: string;
      values: string;
      boundaries: string;
      priorities: string;
    }>;
    identity = parsed.identity ?? identity;
    style = parsed.style ?? style;
    values = parsed.values ?? values;
    boundaries = parsed.boundaries ?? boundaries;
    priorities = parsed.priorities ?? priorities;
  } else {
    const f = args.payload.field;
    const v = args.payload.new_value;
    if (f === "identity") identity = v;
    else if (f === "style") style = v;
    else if (f === "values") values = v;
    else if (f === "boundaries") boundaries = v;
    else if (f === "priorities") priorities = v;
  }

  const sil: Silhouette = {
    id: newSilhouetteId(),
    version: nextVersion,
    identity,
    style,
    values,
    boundaries,
    priorities,
    confidence: args.payload.confidence,
    source_intent: args.intent_id,
    source_agent_id: args.source_agent_id,
    reason: args.reason,
    created_at: Date.now(),
  };
  m[sil.id] = sil;
  await save();
  return sil;
}

/**
 * Slice 7B: record a silhouette version that came from a manual vault edit
 * (no intent, because the edit IS the user's explicit action). Provenance
 * is stamped with `VAULT_SYNC_*` sentinels so it's distinguishable from
 * agent-proposed updates.
 */
export async function recordSilhouetteFromVault(args: {
  fields: {
    identity: string;
    style: string;
    values: string;
    boundaries: string;
    priorities: string;
  };
  confidence: "low" | "medium" | "high";
  reason: string;
}): Promise<Silhouette> {
  const m = await load();
  const current = await getCurrentSilhouette();
  const sil: Silhouette = {
    id: newSilhouetteId(),
    version: (current?.version ?? 0) + 1,
    identity: args.fields.identity,
    style: args.fields.style,
    values: args.fields.values,
    boundaries: args.fields.boundaries,
    priorities: args.fields.priorities,
    confidence: args.confidence,
    source_intent: VAULT_SYNC_INTENT_ID,
    source_agent_id: VAULT_SYNC_AGENT_ID,
    reason: args.reason,
    created_at: Date.now(),
  };
  m[sil.id] = sil;
  await save();
  return sil;
}

/** Test helper. */
export async function _clearAll(): Promise<void> {
  mem = {};
  await save();
}

/** Render a silhouette as Markdown — used by vault-bridge to write yen.md. */
export function renderSilhouetteMarkdown(s: Silhouette): string {
  const updatedAt = new Date(s.created_at).toISOString();
  return `---
name: Duffy 對 Yen 的剪影
version: ${s.version}
updated_at: ${updatedAt}
confidence: ${s.confidence}
source_intent: ${s.source_intent}
---

# Identity

${s.identity}

# Style

${s.style}

# Values

${s.values}

# Boundaries

${s.boundaries}

# Priorities

${s.priorities}

---

_Reason for this version_: ${s.reason}
`;
}

/** Render a silhouette as a compact block for Duffy's system prompt. */
export function renderSilhouetteForPrompt(s: Silhouette): string {
  return `# Silhouette of Yen (v${s.version}, confidence: ${s.confidence})

## Identity
${s.identity}

## Style
${s.style}

## Values
${s.values}

## Boundaries
${s.boundaries}

## Priorities
${s.priorities}`;
}

/** Helper: which fields can a silhouette_update target? */
export const SILHOUETTE_FIELDS: ReadonlyArray<SilhouetteField | "full"> = [
  "identity",
  "style",
  "values",
  "boundaries",
  "priorities",
  "full",
] as const;
