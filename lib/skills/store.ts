/**
 * Skill store — reads/writes the curated skill set in the vault at
 * `06 - AI Data/skills/`. Each skill is a subdirectory containing a SKILL.md
 * with YAML frontmatter (`name`, `description`).
 *
 * The editor saves the WHOLE raw SKILL.md back to disk (no YAML
 * re-serialization), so frontmatter formatting / block scalars are never
 * mangled. The frontmatter parse here is display-only (list view).
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { vaultPath } from "@/lib/vault/reader";

export type SkillMeta = {
  slug: string; // directory name
  name: string;
  description: string;
};

function skillsDir(): string {
  return join(vaultPath(), "06 - AI Data", "skills");
}

/** slug must be a single safe path segment — blocks path traversal. */
function assertSafeSlug(slug: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(slug) || slug === "." || slug === "..") {
    throw new Error("invalid skill slug");
  }
}

/** Resolve a skill's SKILL.md path and verify it stays inside skillsDir. */
function skillFile(slug: string): string {
  assertSafeSlug(slug);
  const dir = skillsDir();
  const file = join(dir, slug, "SKILL.md");
  if (!resolve(file).startsWith(resolve(dir))) {
    throw new Error("path escapes skills directory");
  }
  return file;
}

/** Minimal frontmatter extraction for name + description (display only). */
function parseFrontmatter(raw: string): { name: string; description: string } {
  let name = "";
  let description = "";
  if (!raw.startsWith("---")) return { name, description };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { name, description };
  const fm = raw.slice(3, end).split("\n");
  const strip = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const inline = m[2].trim();
    if (key !== "name" && key !== "description") continue;
    // Block scalar (| or >, optionally with -/+) or empty → gather indented
    // following lines until the next top-level key.
    if (inline === "" || /^[|>][+-]?$/.test(inline)) {
      const buf: string[] = [];
      for (let j = i + 1; j < fm.length; j++) {
        if (/^\S/.test(fm[j])) break; // next top-level key
        buf.push(fm[j].trim());
      }
      const value = buf.join(" ").replace(/\s+/g, " ").trim();
      if (key === "name") name = value;
      else description = value;
    } else {
      if (key === "name") name = strip(inline);
      else description = strip(inline);
    }
  }
  return { name, description };
}

export async function listSkills(): Promise<SkillMeta[]> {
  const dir = skillsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = join(dir, e.name, "SKILL.md");
    try {
      const raw = await fs.readFile(file, "utf8");
      const { name, description } = parseFrontmatter(raw);
      out.push({ slug: e.name, name: name || e.name, description });
    } catch {
      /* no SKILL.md → not a skill, skip */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readSkill(slug: string): Promise<string | null> {
  try {
    return await fs.readFile(skillFile(slug), "utf8");
  } catch {
    return null;
  }
}

export async function writeSkill(slug: string, content: string): Promise<void> {
  await fs.writeFile(skillFile(slug), content, "utf8");
}
