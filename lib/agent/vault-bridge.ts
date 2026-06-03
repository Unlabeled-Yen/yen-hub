/**
 * Vault Bridge — mirror agent-approved records (observations / silhouettes /
 * summaries) into the user's Obsidian vault as Markdown.
 *
 * Why mirror?
 *   - Single source of truth for future multi-agent (Trade/Learn/etc share).
 *   - Yen can open Obsidian and read Duffy's portrait of him directly.
 *   - vault is git-friendly / iCloud-friendly; runtime JSON is not.
 *
 * Where things land (under `$YEN_VAULT_PATH/06 - AI Data/`):
 *   - Observations/YYYY-MM/obs_{id}.md           ← one file per observation
 *   - Silhouettes/yen.md                          ← always the current version
 *   - Silhouettes/archive/{prev_week}.md          ← previous versions archived
 *   - Summaries/{week}.md                         ← one file per ISO week
 *
 * Failure mode: a write error is logged but does NOT throw — the runtime JSON
 * is the truth; vault is best-effort mirror. If vault is missing (env unset),
 * we no-op silently.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Observation,
  Silhouette,
  Summary,
} from "@/lib/agent/storage/types";
import { isoWeek } from "@/lib/agent/storage/types";
import { renderSilhouetteMarkdown } from "@/lib/agent/storage/silhouettes";
import { renderSummaryMarkdown } from "@/lib/agent/storage/summaries";

const AGENT_DATA_DIR = "06 - AI Data";
const OBSERVATIONS_DIR = "Observations";
const SILHOUETTES_DIR = "Silhouettes";
const SUMMARIES_DIR = "Summaries";
const SILHOUETTE_ARCHIVE_DIR = "archive";
const CURRENT_SILHOUETTE_FILE = "yen.md";

function vaultRoot(): string | null {
  return process.env.YEN_VAULT_PATH || null;
}

async function writeFile(absPath: string, content: string): Promise<void> {
  try {
    await fs.mkdir(dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, "utf8");
  } catch (e) {
    console.warn(
      `[vault-bridge] failed to write ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Observation                                                                */
/* -------------------------------------------------------------------------- */

function ymOf(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function renderObservationMarkdown(o: Observation): string {
  const createdAt = new Date(o.created_at).toISOString();
  const evidenceLines = o.evidence
    .map((e) => {
      switch (e.kind) {
        case "attention":
          return `- attention · ${e.zone} · ${e.metric} = ${e.value}${e.window ? ` (${e.window}d)` : ""}`;
        case "vault_file":
          return `- vault_file · \`${e.path}\``;
        case "todo":
          return `- todo · \`${e.file}\` — ${e.text.slice(0, 80)}`;
        case "observation":
          return `- observation · ${e.id}`;
      }
    })
    .join("\n");

  return `---
id: ${o.id}
source_intent: ${o.source_intent}
source_agent_id: ${o.source_agent_id ?? "unknown"}
zone: ${o.zone ?? ""}
window_days: ${o.window?.days ?? ""}
importance: ${o.importance}
created_at: ${createdAt}
---

# ${o.title}

${o.body}

## Why this was recorded

${o.reason}

## Evidence

${evidenceLines || "_(none)_"}
`;
}

export async function writeObservationToVault(obs: Observation): Promise<void> {
  const root = vaultRoot();
  if (!root) return;
  const path = join(
    root,
    AGENT_DATA_DIR,
    OBSERVATIONS_DIR,
    ymOf(obs.created_at),
    `${obs.id}.md`,
  );
  await writeFile(path, renderObservationMarkdown(obs));
}

/* -------------------------------------------------------------------------- */
/*  Silhouette                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Writes the current silhouette to `Silhouettes/yen.md`. If a previous
 * yen.md exists, archives it to `Silhouettes/archive/v{prev_version}-{week}.md`
 * before overwriting.
 */
export async function writeSilhouetteToVault(sil: Silhouette): Promise<void> {
  const root = vaultRoot();
  if (!root) return;
  const dir = join(root, AGENT_DATA_DIR, SILHOUETTES_DIR);
  const currentPath = join(dir, CURRENT_SILHOUETTE_FILE);

  // Archive previous if present (and not the same version, defensively).
  try {
    const existing = await fs.readFile(currentPath, "utf8");
    if (!existing.includes(`version: ${sil.version}`)) {
      const archivePath = join(
        dir,
        SILHOUETTE_ARCHIVE_DIR,
        `v${sil.version - 1}-${isoWeek(new Date())}.md`,
      );
      await fs.mkdir(dirname(archivePath), { recursive: true });
      await fs.writeFile(archivePath, existing, "utf8");
    }
  } catch {
    // No previous file — first write. Skip archive.
  }

  await writeFile(currentPath, renderSilhouetteMarkdown(sil));
}

/* -------------------------------------------------------------------------- */
/*  Summary                                                                    */
/* -------------------------------------------------------------------------- */

export async function writeSummaryToVault(sum: Summary): Promise<void> {
  const root = vaultRoot();
  if (!root) return;
  const path = join(root, AGENT_DATA_DIR, SUMMARIES_DIR, `${sum.week}.md`);
  await writeFile(path, renderSummaryMarkdown(sum));
}
