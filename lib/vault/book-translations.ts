/**
 * Shared book-name translation map.
 *
 * Two layers:
 *   1. Static map below — hand-curated for known books in Yen's library.
 *      First match wins; this is the canonical source of truth for the
 *      books we've already seen.
 *   2. Runtime fallback — when an unknown book appears, `/api/translate-book`
 *      asks Claude for a Chinese translation and writes it back. The result
 *      is cached in `~/Library/Application Support/com.yen.hub/book-translations.json`
 *      so we never re-translate the same book twice.
 *
 * Display format everywhere: `中文書名 ｜ 作者`.
 */

export type BookEntry = { title: string; author: string };

export const BOOK_TRANSLATIONS: Record<string, BookEntry> = {
  // === Currently being read / in active library ===
  "科學與工程的藝術 (Richard Hamming)": {
    title: "科學與工程的藝術",
    author: "Richard Hamming",
  },
  "Human Action (Ludwig von Mises)": {
    title: "人的行為",
    author: "Ludwig von Mises",
  },
  "Intelligence, Creativity, and Wisdom (Robert J. Sternberg)": {
    title: "智力、創造力與智慧",
    author: "Robert J. Sternberg",
  },
  "Book of Wisdom Volume I (revival wisdom)": {
    title: "智慧之書 第一卷",
    author: "Revival Wisdom",
  },
  "如何讀，為什麼讀": {
    title: "如何讀，為什麼讀",
    author: "Harold Bloom",
  },
  "決策的結構 (Robert Axelrod)": {
    title: "決策的結構",
    author: "Robert Axelrod",
  },

  // === Taleb ===
  "Antifragile (Taleb)": {
    title: "反脆弱",
    author: "Nassim Nicholas Taleb",
  },

  // === Idries Shah / Sufi corpus ===
  "Destination Mecca (UK version) (Idries Shah)": {
    title: "通往麥加之路（英國版）",
    author: "Idries Shah",
  },
  "Knowing How to Know (Idries Shah)": {
    title: "如何認知",
    author: "Idries Shah",
  },
  "Observations (Idries Shah)": {
    title: "觀察",
    author: "Idries Shah",
  },
  "Oriental Magic (Idries Shah)": {
    title: "東方魔法",
    author: "Idries Shah",
  },
  "Reflections (Idries Shah [Shah, Idries])": {
    title: "沉思錄",
    author: "Idries Shah",
  },
  "Seeker After Truth (Idries Shah)": {
    title: "真理探求者",
    author: "Idries Shah",
  },
  "Sufi Thought and Action (Idries Shah)": {
    title: "蘇菲思想與行動",
    author: "Idries Shah",
  },
  "The Sufis (Idries Shah)": {
    title: "蘇菲行者",
    author: "Idries Shah",
  },
  "Thinkers of the East (Idries Shah [Shah, Idries])": {
    title: "東方思想家",
    author: "Idries Shah",
  },
  "Wisdom of the Idiots (Idries Shah [Shah, Idries])": {
    title: "愚者的智慧",
    author: "Idries Shah",
  },

  // === Hermetic / esoteric ===
  "The Kybalion (Internet Archive)": {
    title: "卡巴萊昂",
    author: "Internet Archive",
  },
  "靈知-煉金聖杯約櫃與造物主": {
    title: "靈知—煉金、聖杯、約櫃與造物主",
    author: "",
  },

  // === AI / engineering reference ===
  "Managing Memory for AI Agents (Benjamin Labaschin, Jim Allen Wallace etc.)": {
    title: "AI 代理人的記憶管理",
    author: "Benjamin Labaschin",
  },
  "Agentic AI 智能體工作流課程 (memo export)": {
    title: "AI 代理人工作流課程",
    author: "memo export",
  },
  "Claude System Prompts (leaked)": {
    title: "Claude 系統提示詞（外洩版）",
    author: "",
  },
  "Context Cheat Sheet": {
    title: "情境速查表",
    author: "",
  },

  // === Pedagogy / education ===
  "Improving Students Learning With Effective Learning Techniques (Dunlosky et al.)": {
    title: "用有效學習技巧改善學生學習",
    author: "Dunlosky et al.",
  },
  "创新中国教育_江学勤": {
    title: "創新中國教育",
    author: "江學勤",
  },
  "商务动态分析方法_对复杂世界的系统思考与建模": {
    title: "商業動態分析方法：對複雜世界的系統思考與建模",
    author: "",
  },
};

/**
 * Resolve a book's display form. Order:
 *   1. Exact match in BOOK_TRANSLATIONS
 *   2. Parse `Title (Author)` pattern
 *   3. Bare title only
 *
 * For unknown books that fall through to layer 2 or 3, the client should
 * fire `/api/translate-book` to upgrade the entry — see book-translation
 * cache below.
 */
export function parseBook(raw: string): { author: string | null; title: string } {
  const known = BOOK_TRANSLATIONS[raw];
  if (known) return { title: known.title, author: known.author || null };
  const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { title: m[1].trim(), author: m[2].trim() };
  return { author: null, title: raw.trim() };
}

export function bookDisplay(rawName: string): string {
  const { author, title } = parseBook(rawName);
  return author ? `${title} ｜ ${author}` : title;
}
