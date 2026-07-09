/**
 * Shared signal-card translation — Traditional Chinese (Taiwan).
 *
 * Extracted so both the IBM Think route and the GitHub trending route can
 * translate {title, summary} cards the same way. Mirrors the proven IBM
 * pipeline:
 *   - dedicated fast model (Moonshot-v1-32k), NOT Duffy's reasoning K2.6
 *   - small parallel chunks (chunk=3) to keep wall-clock ~4s for 24 items
 *   - OpenCC `twp` post-process as a belt-and-braces simplified→traditional
 *     guard, because Moonshot ignores "繁體 only" once batched past ~3 items
 *   - silent failure: callers fall back to English when *Zh fields are null
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import * as OpenCC from "opencc-js";
import { hasAnyLLMKey } from "@/lib/ai/model";

const cn2tw = OpenCC.Converter({ from: "cn", to: "twp" });

export type TranslationStatus =
  | "ok"
  | "pending"
  | "no-key"
  | "timeout"
  | "parse-error"
  | "llm-error"
  | "partial";

export type Translatable = { title: string; summary: string };
export type Translated = {
  titleZh: string | null;
  summaryZh: string | null;
  /** 1–3 normalized English topic tags the LLM assigned to this card.
   *  Empty when extraction failed or was disabled. */
  topics: string[];
};

export type TranslateResult<T> = {
  items: T[];
  status: TranslationStatus;
  note?: string;
  translated: number;
};

function pickTranslateModel(): {
  model: LanguageModel;
  family: "kimi" | "anthropic";
} {
  const override = process.env.SIGNALS_TRANSLATE_MODEL;
  if (process.env.KIMI_API_KEY) {
    const kimi = createOpenAICompatible({
      name: "kimi",
      apiKey: process.env.KIMI_API_KEY,
      baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1",
    });
    return { model: kimi(override ?? "moonshot-v1-32k"), family: "kimi" };
  }
  return {
    model: anthropic(override ?? "claude-haiku-4-5-20251001"),
    family: "anthropic",
  };
}

type ChunkVal = { title?: string; summary?: string; topics?: string[] };
type ChunkResult =
  | { ok: true; map: Map<number, ChunkVal> }
  | { ok: false; reason: TranslationStatus; note?: string };

async function translateChunk(
  chunk: Translatable[],
  globalIndex: number[],
  label: string,
  titleRule: string,
): Promise<ChunkResult> {
  const payload = chunk.map((it, i) => ({
    i,
    title: it.title,
    summary: it.summary,
  }));

  const prompt = [
    "把以下英文卡片翻譯成「臺灣正體中文（zh-TW / 繁體中文）」。",
    "",
    "硬性規則（違反任何一條都算失敗，請逐條檢查再輸出）：",
    "1. 只能用繁體字。禁止出現下列簡化字：体国应学选设动报问连标识网为么这样个发觉证们时间将动当。",
    "   範例對照：体→體、简→簡、应→應、学→學、为→為、动→動、问→問、设→設、网→網、报→報、识→識。",
    "2. 臺灣科技用語：人工智慧（不是「人工智能」）、軟體（不是「软件」）、程式（不是「程序」）、",
    "   數位（不是「数字」）、AI 代理（不是「智能体」）、多模態（不是「多模态」）。",
    "3. 自然、流暢，像臺灣科技媒體編譯。",
    "4. 公司名、人名、產品名、技術專有名詞（AI、LLM、RAG、GitHub、PyTorch…）保留原文。",
    titleRule,
    "6. summary 處理規則（重要）：",
    "   - 若輸入的 summary 是空字串「\"\"」，輸出 summary 必須也是空字串「\"\"」。",
    "   - 嚴禁從 title 推測、擴寫、編造任何 summary 內容。",
    "   - 若輸入的 summary 有內容，忠實翻譯，字數不超過原文 1.3 倍。",
    "7. topics 欄位（語意主題標籤，給趨勢分析用，極重要）：",
    "   - 只抽「這篇真正在講的 1~2 個核心主題」，寧缺勿濫。",
    "   - 嚴禁抽『邊緣關聯／順帶提到』的主題。判斷標準：如果這個標籤『不是這篇的主旨、只是順帶沾到』，就不要抽。",
    "     反例（錯誤示範）：一篇講『客服 AI 代理協作』的文章，topics 只該是 [\"AI agents\"]，",
    "     不可加 \"automation\"、\"customer service\" 這種沾邊但非主旨的詞；",
    "     一篇講『零售業信任』的文章不要硬抽 \"supply chain\"。",
    "   - 標籤要是有意義的 AI 領域概念，例如：\"AI agents\", \"RAG\", \"multimodal AI\", \"quantum computing\",",
    "     \"AI safety\", \"LLM training\", \"AI governance\", \"robotics\", \"vector database\", \"fine-tuning\"。",
    "   - 用「規範化的通用說法」，同義詞要歸一：agentic/agent → \"AI agents\"；多模態 → \"multimodal AI\"。",
    "   - 嚴禁輸出無意義的詞：年份（2026）、泛詞（data, model, tool, new, work, automation, AI 單獨一字）、停用詞。",
    "   - 標籤一律用英文（方便跨來源聚合）。若這篇跟 AI / 科技無關或主題不明，topics 給空陣列 []。",
    "8. 每個 item 都必須完整輸出 {i, title, summary, topics} 四個欄位 — summary 空字串也要保留，topics 至少給 []。",
    "9. 只輸出純 JSON，不要任何前後說明文字、不要 markdown 圍欄。",
    "",
    "輸入：",
    JSON.stringify(payload),
    "",
    '輸出格式：{"items":[{"i":0,"title":"…","summary":"…","topics":["…"]}, …]}',
  ].join("\n");

  // Moonshot hangs intermittently — a single request occasionally never
  // returns. The fix is per-ATTEMPT timeout + retry with a fresh request,
  // not one long wait: a hung request is abandoned quickly and a new one
  // almost always returns in a few seconds. Total worst case = attempts ×
  // attemptMs, but the common path succeeds on attempt 1.
  const attemptMs = Number(process.env.SIGNALS_TRANSLATE_ATTEMPT_MS) || 18_000;
  const maxAttempts = Number(process.env.SIGNALS_TRANSLATE_RETRIES) || 3;
  const { model } = pickTranslateModel();

  let lastReason: TranslationStatus = "llm-error";
  let lastNote = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), attemptMs);
    try {
      const { text } = await generateText({
        model,
        system:
          "你是臺灣科技媒體的編譯。輸出只准使用繁體中文（zh-TW），絕不出現任何簡體字。" +
          "輸出純 JSON，不加 markdown 圍欄。",
        prompt,
        temperature: 0.2,
        abortSignal: ctrl.signal,
      });
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd <= jsonStart) {
        lastReason = "parse-error";
        lastNote = "no-json";
        console.warn(`[${label}] chunk@${globalIndex[0]} attempt ${attempt}: no JSON braces.`);
        continue; // retry — a malformed reply is often transient too
      }
      let parsed: {
        items?: Array<{
          i: number;
          title?: string;
          summary?: string;
          topics?: string[];
        }>;
      };
      try {
        parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      } catch (e) {
        lastReason = "parse-error";
        lastNote = (e as Error).message;
        console.warn(`[${label}] chunk@${globalIndex[0]} attempt ${attempt}: JSON.parse threw:`, (e as Error).message);
        continue;
      }
      const map = new Map<
        number,
        { title?: string; summary?: string; topics?: string[] }
      >();
      for (const r of parsed.items ?? []) {
        const g = globalIndex[r.i];
        if (g != null) {
          map.set(g, {
            title: r.title,
            summary: r.summary,
            topics: Array.isArray(r.topics) ? r.topics : [],
          });
        }
      }
      if (attempt > 1) {
        console.log(`[${label}] chunk@${globalIndex[0]} recovered on attempt ${attempt}`);
      }
      return { ok: true, map };
    } catch (e) {
      const isAbort = (e as Error).name === "AbortError";
      lastReason = isAbort ? "timeout" : "llm-error";
      lastNote = isAbort ? `attempt-timeout-${attemptMs}ms` : (e as Error).message;
      console.warn(`[${label}] chunk@${globalIndex[0]} attempt ${attempt}/${maxAttempts} failed:`, lastNote);
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, reason: lastReason, note: lastNote };
}

/**
 * Translate an array of cards. The caller supplies how to read the
 * English {title, summary} from each item and how to write the translated
 * fields back, so this works for any card shape (IBM article, GitHub repo).
 */
/** Default rule 5 — faithful title translation (IBM articles). */
const TITLE_RULE_TRANSLATE = "5. 標題簡潔有力，與原英文字數相當。";

/** Rule 5 for GitHub repos — the "title" is a long English description; we
 *  want a SHORT functional Chinese name, not a literal translation. */
export const TITLE_RULE_REPO_NAME =
  "5. title 欄位是 GitHub 專案的英文描述（可能很長、含行銷話術）。請『濃縮』成「一句簡潔的繁體中文功能名稱」，" +
  "最多 16 個字，像中文軟體名／一句話介紹，只講核心功能。嚴禁逐字翻譯整段、嚴禁超過一句、嚴禁照抄 emoji 清單。" +
  "範例：'Open-source & free code review tool, hybrid pipeline + LLM agents' → '開源 LLM 程式碼審查工具'；" +
  "'The agentic HTML editor — your local AI writes HTML' → '本地 AI 代理網頁編輯器'。";

export async function translateCards<T>(
  items: T[],
  read: (item: T) => Translatable,
  write: (item: T, tr: Translated) => T,
  label: string,
  titleRule: string = TITLE_RULE_TRANSLATE,
): Promise<TranslateResult<T>> {
  if (items.length === 0) return { items, status: "ok", translated: 0 };
  if (!hasAnyLLMKey()) {
    console.warn(`[${label}] translation skipped — no LLM key in env`);
    return { items, status: "no-key", translated: 0 };
  }

  const CHUNK_SIZE = Number(process.env.SIGNALS_TRANSLATE_CHUNK) || 3;
  const translatable = items.map(read);
  const chunks: { items: Translatable[]; index: number[] }[] = [];
  for (let i = 0; i < translatable.length; i += CHUNK_SIZE) {
    const slice = translatable.slice(i, i + CHUNK_SIZE);
    chunks.push({ items: slice, index: slice.map((_, j) => i + j) });
  }

  const t0 = Date.now();
  const results = await Promise.all(
    chunks.map((c) => translateChunk(c.items, c.index, label, titleRule)),
  );
  console.log(`[${label}] ${chunks.length} translate chunks in ${Date.now() - t0}ms`);

  const combined = new Map<number, ChunkVal>();
  let firstFailure: { reason: TranslationStatus; note?: string } | null = null;
  for (const r of results) {
    if (r.ok) for (const [k, v] of r.map) combined.set(k, v);
    else if (!firstFailure) firstFailure = { reason: r.reason, note: r.note };
  }

  let translated = 0;
  const merged = items.map((it, i) => {
    const tr = combined.get(i);
    if (!tr || !tr.title?.trim()) return it;
    translated++;
    const sumRaw = tr.summary?.trim();
    const topics = (tr.topics ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 3);
    return write(it, {
      titleZh: cn2tw(tr.title.trim()),
      summaryZh: sumRaw ? cn2tw(sumRaw) : null,
      topics,
    });
  });

  if (translated === 0) {
    return {
      items,
      status: firstFailure?.reason ?? "parse-error",
      note: firstFailure?.note ?? "empty-map",
      translated: 0,
    };
  }
  return {
    items: merged,
    status: translated === items.length ? "ok" : "partial",
    note: firstFailure?.note,
    translated,
  };
}
