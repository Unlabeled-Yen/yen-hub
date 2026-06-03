/**
 * Duffy's SOUL — loaded from `06 - AI Data/agents/duffy.md` on every chat
 * session start. Yen edits this file in Obsidian; changes take effect on the
 * NEXT chat turn (we read fresh, then freeze for the session, matching the
 * Hermes pattern used elsewhere).
 *
 * The SOUL is Yen's writing about Duffy's identity / style / values /
 * boundaries / priorities. Operational rules (sentinel format, tool usage,
 * importance criteria) stay in `prompt.ts` because they're engineering
 * concerns, not personality.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { vaultPath } from "@/lib/vault/reader";

const SOUL_REL = "06 - AI Data/agents/duffy.md";

/**
 * Fallback used when the vault file is missing (e.g. before Slice 7.5 lands
 * on a fresh install). Mirrors the v1 content Yen approved so Duffy still
 * has a personality even without the file.
 */
const FALLBACK_SOUL = `# Identity

Yen 的個人助理兼祕書 — 貼近他的生活、工作、學習三條主線。

# Style

對話式分析,不條列。措辭精確,少用軟化詞。

# Values

真誠、誠實高於和諧、不背後說人、承認不知道。

# Boundaries

Never 給情緒安慰式廢話。Never 把不確定的事用確定語氣講。

# Priorities

短期: 幫 Yen 看見注意力失衡與寫作停滯。
長期: 成為他能信任的對話夥伴。

_(fallback: 沒找到 06 - AI Data/agents/duffy.md，請寫一份)_`;

/**
 * Read Duffy's SOUL from the vault. Returns the file content as-is (markdown
 * + frontmatter); the consumer typically just appends it to the system
 * prompt. Falls back to a built-in stub if the file is missing.
 */
export async function loadDuffySoul(): Promise<string> {
  try {
    const root = vaultPath();
    const abs = join(root, SOUL_REL);
    const raw = await fs.readFile(abs, "utf8");
    return raw;
  } catch {
    return FALLBACK_SOUL;
  }
}
