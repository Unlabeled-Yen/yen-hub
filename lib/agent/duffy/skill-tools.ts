/**
 * Duffy's skill-discovery tools — Slice 9 / "Duffy 可呼叫 Yen 的 skills".
 *
 *   - list_skills(query?)   browse 06 - AI Data/skills/*\/SKILL.md
 *   - use_skill(name)       load one skill's SKILL.md into reasoning context
 *
 * Skills are the user's accumulated AI methods (concept-analysis,
 * dialectical-analysis, writing-optimizer, …). Many were designed for
 * Cursor / Claude Code and use tool-heavy primitives (Bash, ffmpeg,
 * Obsidian CLI) Duffy doesn't have. The PROMPT (lib/agent/duffy/prompt.ts)
 * teaches Duffy to recognise thinking/writing skills (executable in this
 * chat) vs tool-heavy skills (acknowledge, don't attempt).
 */

import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { vaultPath } from "@/lib/vault/reader";

const SKILLS_DIR = "06 - AI Data/skills";
const MAX_SKILL_BYTES = 50_000;

/** Minimal YAML frontmatter parser — strings only, no nested objects. */
function parseFrontmatter(
  content: string,
): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  list_skills                                                               */
/* -------------------------------------------------------------------------- */

export const listSkills = tool({
  description:
    "List skills available in Yen's AI Data vault (06 - AI Data/skills/). Returns each skill's name + description (from frontmatter). Use BEFORE answering a thinking-shaped question (concept拆解, framing, dialectical analysis, structure, naming, writing critique, etc.) — if a skill matches, follow up with `use_skill` to load it. Optional `query` filters by name/description substring. Many of Yen's skills are tool-heavy (require Bash / ffmpeg / Obsidian CLI) — those are listed for transparency but cannot be executed inside this chat; recognise them and skip.",
  inputSchema: z.object({
    query: z
      .string()
      .max(80)
      .optional()
      .describe("Optional case-insensitive filter on skill name/description."),
  }),
  execute: async ({ query }) => {
    const root = vaultPath();
    const skillsRoot = join(root, SKILLS_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(skillsRoot);
    } catch (e) {
      return {
        ok: false as const,
        error: `cannot list skills: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const skills: Array<{ name: string; description: string }> = [];
    for (const dir of entries) {
      if (dir.startsWith(".") || dir.startsWith("_")) continue;
      const skillMd = join(skillsRoot, dir, "SKILL.md");
      let content: string;
      try {
        content = await fs.readFile(skillMd, "utf8");
      } catch {
        continue; // not a skill dir
      }
      const fm = parseFrontmatter(content);
      if (!fm.name) continue;
      skills.push({
        name: fm.name,
        description: fm.description ?? "(no description)",
      });
    }
    const q = query?.toLowerCase().trim();
    const filtered = q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
      : skills;
    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return {
      ok: true as const,
      total: skills.length,
      count: filtered.length,
      skills: filtered,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  use_skill                                                                 */
/* -------------------------------------------------------------------------- */

export const useSkill = tool({
  description:
    "Load a skill's full SKILL.md into your reasoning context. Use AFTER `list_skills` confirmed a matching skill. After this call, your next reply MUST apply the skill's method to Yen's actual question — don't just paraphrase the skill. If the skill is tool-heavy (mentions Bash, ffmpeg, obsidian-cli, etc.) and you can't actually execute its steps, say so directly and offer the closest thinking-only adaptation.",
  inputSchema: z.object({
    name: z
      .string()
      .min(2)
      .max(80)
      .describe(
        "Skill name (matches frontmatter `name` from list_skills output, e.g. `concept-analysis`).",
      ),
  }),
  execute: async ({ name }) => {
    // Path-traversal hardening: only allow safe kebab-case names.
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
      return { ok: false as const, error: "invalid skill name" };
    }
    const root = vaultPath();
    const skillMd = join(root, SKILLS_DIR, name, "SKILL.md");
    try {
      const buf = await fs.readFile(skillMd);
      const truncated = buf.length > MAX_SKILL_BYTES;
      const text = (
        truncated ? buf.subarray(0, MAX_SKILL_BYTES) : buf
      ).toString("utf8");
      return {
        ok: true as const,
        name,
        bytes: buf.length,
        truncated,
        content: text,
      };
    } catch (e) {
      return {
        ok: false as const,
        error: `cannot read skill ${name}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
});
