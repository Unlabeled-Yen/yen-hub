/**
 * Skill categories — an app-managed mapping of skill slug → category, stored
 * outside the vault so it doesn't touch the SKILL.md files. Lives next to
 * conversations.json in the app support dir.
 *
 * Always re-read from disk (no forever-cache) for the same reason the
 * conversation store does: API routes and other bundles may hold separate
 * module instances.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "skill-categories.json");

export type CategoryMap = Record<string, string>; // slug → category

export async function readCategories(): Promise<CategoryMap> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as CategoryMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function setCategory(
  slug: string,
  category: string | null,
): Promise<void> {
  const map = await readCategories();
  if (category && category.trim()) {
    map[slug] = category.trim();
  } else {
    delete map[slug];
  }
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {
    /* silent */
  }
}
