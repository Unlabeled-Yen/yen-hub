/**
 * Rule-based TODO classifier — strategy E.
 *
 * Most Queue files have meaningful names (寫作品牌策略_誠實診斷與整合,
 * Skill能力展示_RLHF, deep-research-protocol-v1 …). The filename IS the
 * category for ~90% of TODOs. AI fallback is reserved for genuinely mixed
 * files (今日待辦, hub-triage) where one file holds several unrelated items.
 *
 * `classifyTodo(filePath, text)` returns:
 *   { category: string, needsAi: boolean }
 *
 * When `needsAi` is true, the API can batch-send those TODOs to Claude for
 * finer-grained labeling. Wiring that call is a follow-up — for v1 we just
 * mark them "AI 待分類" so they cluster together in the UI.
 */

export type ClassifyResult = {
  category: string;
  needsAi: boolean;
};

// Highest specificity first — the first match wins.
const RULES: { pattern: RegExp; category: string }[] = [
  // Writing — split by sub-topic
  { pattern: /寫作品牌|品牌策略|寫作經營|經營藍圖/, category: "寫作 ／ 品牌" },
  { pattern: /寫作系統|寫作待辦|寫作端原則/, category: "寫作 ／ 系統" },
  { pattern: /閱讀的過程|Hamming.*系統工程|iPAS規劃師/, category: "寫作 ／ 主題" },
  { pattern: /WritingSkill|writing-v1/, category: "寫作 ／ Skill" },
  { pattern: /寫作/, category: "寫作 ／ 其他" },

  // AI Toolkit / agents / skills
  { pattern: /Agent系統|agentic|Agent/, category: "AI ／ Agent" },
  { pattern: /skill-design|Skill能力|Skill/, category: "AI ／ Skill" },
  { pattern: /ClaudeCode|claude-code/, category: "AI ／ Claude Code" },
  { pattern: /AI助理|AI骨架|AI建造/, category: "AI ／ 助理設計" },
  { pattern: /AI轉型|AI時代|AI生活|AI價值觀|AI價值/, category: "AI ／ 趨勢學習" },
  { pattern: /AI.*翻譯|Memo_AI/, category: "AI ／ Debug" },
  { pattern: /Content_AI|內容.*AI|AI.*內容/, category: "AI ／ 內容工程" },
  { pattern: /AI/, category: "AI ／ 其他" },

  // Research methodology
  { pattern: /deep-research|research-guideline|research-protocol|research-fault/, category: "研究方法" },
  { pattern: /研究/, category: "研究 ／ 其他" },

  // Learning / curriculum design
  { pattern: /評估設計/, category: "學習 ／ 評估設計" },
  { pattern: /綜合學習/, category: "學習 ／ 綜合" },
  { pattern: /RLHF|機器學習/, category: "學習 ／ ML" },
  { pattern: /學習/, category: "學習 ／ 其他" },

  // Self-exploration / mental
  { pattern: /exploration|探索|恐懼/, category: "探索" },

  // Vault / hub maintenance
  { pattern: /Vault.*健康|健康報告|vault健康/, category: "Vault 維護" },
  { pattern: /Obsidian|庫結構|MOC/, category: "Vault 結構" },

  // Misc tooling
  { pattern: /doc-to-md|tool-contract/, category: "工具開發" },
  { pattern: /sandbox/, category: "實驗" },
];

// Files known to be a mixed bag — flag for AI breakdown.
const AI_NEEDED = /hub-triage|今日待辦|綜合待辦|雜.*待辦/;

export function classifyTodo(filePath: string, _text: string): ClassifyResult {
  // Build a "signature" string that includes BOTH the parent directory name
  // (often the topic, e.g. `寫作經營藍圖_2026-05-16`) AND the filename, so
  // rules can match the topic even when the file is itself generic like
  // `INDEX.md` or `website-prompt-v1.md`.
  const parts = filePath.split("/");
  const filename = (parts.pop() ?? "").replace(/\.md$/, "");
  const parent = parts.pop() ?? "";
  const signature =
    `${parent} ${filename}`.replace(/_?\d{4}-\d{2}-\d{2}/g, "").trim();

  if (AI_NEEDED.test(signature)) {
    return { category: "AI 待分類", needsAi: true };
  }

  for (const r of RULES) {
    if (r.pattern.test(signature)) {
      return { category: r.category, needsAi: false };
    }
  }
  return { category: "其他", needsAi: false };
}
