/**
 * Vault → JSON reverse sync — Slice 7B.
 *
 * Inverse of `lib/agent/vault-bridge.ts`. When Yen manually edits
 * `06 - AI Data/Silhouettes/yen.md` in Obsidian, this module parses the
 * Markdown back into a Silhouette record and writes it to silhouettes.json.
 *
 * Trust model: a manual vault edit is an explicit Yen action, so the new
 * version lands WITHOUT going through the intent approval flow. The reason
 * field is stamped accordingly so provenance stays clear.
 *
 * Idempotent: compares parsed content with current Silhouette and short-
 * circuits when identical (avoids spamming versions on noop syncs).
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { vaultPath } from "@/lib/vault/reader";
import {
  getCurrentSilhouette,
  recordSilhouetteFromVault,
  renderSilhouetteMarkdown,
} from "@/lib/agent/storage/silhouettes";
import { writeSilhouetteToVault } from "@/lib/agent/vault-bridge";
import { bustCoachCache } from "@/lib/agent/duffy/coach";

const YEN_MD_REL = "06 - AI Data/Silhouettes/yen.md";

export type SyncResult =
  | { status: "no-file" }
  | { status: "no-change"; reason: string }
  | { status: "updated"; version: number }
  | { status: "refused"; reason: string };

/* -------------------------------------------------------------------------- */
/*  Markdown parser                                                            */
/* -------------------------------------------------------------------------- */

type Parsed = {
  frontmatter: {
    version?: number;
    confidence?: string;
  };
  fields: {
    identity: string;
    style: string;
    values: string;
    boundaries: string;
    priorities: string;
  };
};

const SECTION_NAMES = [
  "identity",
  "style",
  "values",
  "boundaries",
  "priorities",
] as const;

export function parseSilhouetteMarkdown(content: string): Parsed {
  // Extract frontmatter — `^---\n...\n---\n`
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error("missing or malformed frontmatter");
  }
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  const body = fmMatch[2];

  // Parse 5 sections by `# Heading` (case-insensitive).
  const sections: Record<string, string> = {};
  const re = /^#\s+(\w+)\s*\r?\n([\s\S]*?)(?=\r?\n#\s+\w+|\r?\n---|\s*$)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const key = m[1].toLowerCase();
    sections[key] = m[2].trim();
  }

  // Stripped reason footer like "_Reason for this version_: ..."
  for (const k of SECTION_NAMES) {
    if (typeof sections[k] === "string") {
      sections[k] = sections[k]
        .replace(/^\s*---\s*[\s\S]*$/m, "")
        .trim();
    }
  }

  return {
    frontmatter: {
      version: fm.version ? Number(fm.version) : undefined,
      confidence: fm.confidence,
    },
    fields: {
      identity: sections.identity ?? "",
      style: sections.style ?? "",
      values: sections.values ?? "",
      boundaries: sections.boundaries ?? "",
      priorities: sections.priorities ?? "",
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Sync                                                                       */
/* -------------------------------------------------------------------------- */

export async function syncSilhouetteFromVault(): Promise<SyncResult> {
  const root = vaultPath();
  const abs = join(root, YEN_MD_REL);

  // Step 1: file existence.
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return { status: "no-file" };
  }

  const current = await getCurrentSilhouette();

  // Step 2: if current JSON is newer than the file, nothing to sync.
  if (current && current.created_at >= stat.mtimeMs) {
    return { status: "no-change", reason: "json newer than vault file" };
  }

  // Step 3: parse the file.
  const content = await fs.readFile(abs, "utf8");
  const parsed = parseSilhouetteMarkdown(content);

  // Step 4: bail if fields are identical (avoid noop versions).
  if (
    current &&
    current.identity === parsed.fields.identity &&
    current.style === parsed.fields.style &&
    current.values === parsed.fields.values &&
    current.boundaries === parsed.fields.boundaries &&
    current.priorities === parsed.fields.priorities
  ) {
    return { status: "no-change", reason: "content identical to current" };
  }

  // Step 4.5: REFUSE to overwrite meaningful content with all-empty.
  //
  // 2026-06-11 — root cause of the v1 → v4 silhouette wipeout. A bad edit to
  // yen.md (likely Obsidian round-trip leaving only duplicate `# Heading`
  // lines) parsed into 5 empty fields. The sync dutifully replaced Duffy's
  // rich v1 with empties, then re-rendered the empties back to yen.md, then
  // re-parsed its own output two more times (v3, v4) compounding the damage
  // because the renderer's duplicate `# Heading` output then re-matched as
  // section content. The strict ratchet here breaks the wipeout loop: if
  // the parse yields all-empty AND we *have* meaningful current content,
  // refuse the sync and tell the user why. Recovery (when you intentionally
  // want to clear sections) goes through Duffy proposing a silhouette_update
  // intent instead — that path is gated by approval, so it's safe.
  if (current) {
    const allEmptyParsed =
      !parsed.fields.identity.trim() &&
      !parsed.fields.style.trim() &&
      !parsed.fields.values.trim() &&
      !parsed.fields.boundaries.trim() &&
      !parsed.fields.priorities.trim();
    const currentHasContent =
      Boolean(current.identity.trim()) ||
      Boolean(current.style.trim()) ||
      Boolean(current.values.trim()) ||
      Boolean(current.boundaries.trim()) ||
      Boolean(current.priorities.trim());
    if (allEmptyParsed && currentHasContent) {
      return {
        status: "refused",
        reason:
          "yen.md 解析後 5 個欄位都空白，但目前剪影有內容；拒絕用空白覆蓋。" +
          "若真的想清空，請改用 Duffy 提案（silhouette_update intent）",
      };
    }
  }

  // Step 5: record the new version + mirror back to vault to refresh
  // frontmatter (version, updated_at, source).
  const confidence =
    parsed.frontmatter.confidence === "low" ||
    parsed.frontmatter.confidence === "medium" ||
    parsed.frontmatter.confidence === "high"
      ? parsed.frontmatter.confidence
      : current?.confidence ?? "medium";

  const sil = await recordSilhouetteFromVault({
    fields: parsed.fields,
    confidence,
    reason:
      "從 vault yen.md 反向同步（使用者手動編輯）。Slice 7B vault-sync。",
  });

  await writeSilhouetteToVault(sil);
  bustCoachCache();
  // Ensure the freshly-written Markdown reflects the canonical render.
  void renderSilhouetteMarkdown;

  return { status: "updated", version: sil.version };
}
