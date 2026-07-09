/**
 * English AI-topic tag → Traditional-Chinese label.
 *
 * The LLM emits normalized English topic tags (for cross-source aggregation).
 * The war-room shows them bilingually, so we map the common ones to Chinese
 * here. Unknown tags fall back to the English term — acceptable, since rare
 * tags are usually already English acronyms (RAG, LLM, MLOps).
 *
 * Keys are matched case-insensitively. Keep this list curated to the tags the
 * extraction prompt is told to prefer; add entries as new normalized tags
 * show up in the wild.
 */
const MAP: Record<string, string> = {
  "ai agents": "AI 代理",
  "ai agent": "AI 代理",
  "agentic ai": "代理式 AI",
  agentic: "代理式 AI",
  rag: "檢索增強生成",
  "retrieval augmented generation": "檢索增強生成",
  "multimodal ai": "多模態 AI",
  multimodal: "多模態",
  "quantum computing": "量子運算",
  quantum: "量子",
  "ai ethics": "AI 倫理",
  "ai governance": "AI 治理",
  "ai safety": "AI 安全",
  "ai security": "AI 資安",
  "ai leadership": "AI 領導",
  "ai strategy": "AI 策略",
  "ai projects": "AI 專案",
  "ai adoption": "AI 導入",
  "ai regulation": "AI 法規",
  "llm training": "LLM 訓練",
  "llm": "大型語言模型",
  "large language models": "大型語言模型",
  "fine-tuning": "微調",
  "fine tuning": "微調",
  "vector database": "向量資料庫",
  "vector search": "向量搜尋",
  "data generation": "資料生成",
  "synthetic data": "合成資料",
  "data issues": "資料問題",
  "data quality": "資料品質",
  "data centers": "資料中心",
  "data streaming": "資料串流",
  "data infrastructure": "資料基礎設施",
  robotics: "機器人",
  "autonomous systems": "自主系統",
  "computer vision": "電腦視覺",
  "speech recognition": "語音辨識",
  "text-to-image": "文生圖",
  "image generation": "影像生成",
  "model inference": "模型推論",
  "edge ai": "邊緣 AI",
  mlops: "MLOps",
  "prompt engineering": "提示工程",
  "open source ai": "開源 AI",
  "enterprise ai": "企業 AI",
  "ai infrastructure": "AI 基礎設施",
  observability: "可觀測性",
  cybersecurity: "資安",
  "machine responsibility": "機器問責",
  traceability: "可追溯性",
  "human-ai interaction": "人機互動",
  "ai understanding": "AI 理解",
  "customer service": "客戶服務",
  trust: "信任",
  retail: "零售",
  "space technology": "太空科技",
};

/** Chinese label for an English topic tag, or the original tag if unmapped. */
export function topicZh(term: string): string {
  return MAP[term.trim().toLowerCase()] ?? term;
}

/** True when we have a real Chinese translation (not the English fallback). */
export function hasZh(term: string): boolean {
  return term.trim().toLowerCase() in MAP;
}
