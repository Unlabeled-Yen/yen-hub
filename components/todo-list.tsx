"use client";

/**
 * TodoList — Page A 右半的待辦事項面板。
 *
 * 兩個 tab：
 *   - 種類：按 zone 分組（Yen Hub / AI建造 / 寫作草稿 / 佇列 / …）
 *   - 急迫：按 file mtime 分三級（< 3 天=急、3-14=中、> 14=低）
 *
 * Tab 切換不重新 fetch，所有資料前端 group。
 */

import { motion, AnimatePresence } from "motion/react";
import { useEffect, useMemo, useState } from "react";

type Todo = {
  file: string;
  lineNum: number;
  text: string;
  zone: string;
  category: string;
  needsAi: boolean;
  mtimeMs: number;
};

type TodosResponse = { items: Todo[] };

const EASE: [number, number, number, number] = [0.075, 0.82, 0.165, 1];

// Zone → 中文標籤（內聯複製；reader.ts 的 ZONE_LABEL 是 server-side 字串
// 帶 emoji，這裡要乾淨無 emoji 的純標籤）
const ZONE_LABEL: Record<string, string> = {
  yenhub: "Yen Hub",
  workshop: "AI 建造",
  queue: "佇列",
  drafts: "寫作草稿",
  writing: "主筆記",
  septic: "筆記摘錄",
  library: "圖書館",
  indexes: "規約 / 索引",
  derived: "加工筆記",
  trading: "交易複盤",
  other: "其他",
};

type Tab = "category" | "urgency";
type Urgency = "high" | "med" | "low";

function urgencyOf(mtimeMs: number): Urgency {
  const days = (Date.now() - mtimeMs) / 86_400_000;
  if (days < 3) return "high";
  if (days < 14) return "med";
  return "low";
}

const URGENCY_LABEL: Record<Urgency, string> = {
  high: "急",
  med: "中",
  low: "低",
};

const URGENCY_COLOR: Record<Urgency, string> = {
  high: "rgba(255,150,90,0.95)",
  med: "rgba(255,210,150,0.85)",
  low: "rgba(180,190,200,0.75)",
};

function dayLabel(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 週前`;
  return `${Math.floor(days / 30)} 月前`;
}

function fileName(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

function trunc(text: string, max = 60): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function TodoItem({ t, index }: { t: Todo; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.45, delay: index * 0.025, ease: EASE }}
      className="font-mono min-w-0"
    >
      {/* break-words handles long unbroken strings like inline file paths
          (`LLM Wiki 知識庫/...`); won't blow out the column. */}
      <div className="text-[12px] text-[var(--fg-0)] leading-snug break-words">
        {trunc(t.text, 90)}
      </div>
      <div className="text-[10px] text-[var(--fg-2)] mt-1 flex items-center gap-2 min-w-0">
        <span className="truncate flex-1 min-w-0">{fileName(t.file)}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span className="tabular-nums whitespace-nowrap">
          {dayLabel(t.mtimeMs)}
        </span>
      </div>
    </motion.div>
  );
}

function GroupBlock({
  title,
  count,
  color,
  todos,
  startIndex,
}: {
  title: string;
  count: number;
  color: string;
  todos: Todo[];
  startIndex: number;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline gap-2 font-mono">
        <span
          className="text-[11px] tracking-[0.20em] uppercase"
          style={{ color }}
        >
          {title}
        </span>
        <span className="text-[10px] text-[var(--fg-2)] tabular-nums">
          {count}
        </span>
      </div>
      <div className="space-y-2.5 pl-3 border-l border-white/[0.06]">
        {todos.map((t, i) => (
          <TodoItem key={`${t.file}:${t.lineNum}`} t={t} index={startIndex + i} />
        ))}
      </div>
    </div>
  );
}

export function TodoList() {
  const [data, setData] = useState<TodosResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("category");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/vault/todos", {
          credentials: "same-origin",
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const json = (await r.json()) as TodosResponse;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!data) return null;
    const items = data.items;

    // By category — use classify.ts result, not raw zone
    const byCategory = new Map<string, Todo[]>();
    for (const t of items) {
      const arr = byCategory.get(t.category) ?? [];
      arr.push(t);
      byCategory.set(t.category, arr);
    }
    const categories = Array.from(byCategory.entries())
      .map(([cat, ts]) => ({ category: cat, todos: ts }))
      .sort((a, b) => {
        // "AI 待分類" sinks to bottom regardless of count
        if (a.category === "AI 待分類") return 1;
        if (b.category === "AI 待分類") return -1;
        return b.todos.length - a.todos.length;
      });

    // By urgency
    const byUrgency: Record<Urgency, Todo[]> = { high: [], med: [], low: [] };
    for (const t of items) byUrgency[urgencyOf(t.mtimeMs)].push(t);

    return { categories, byUrgency };
  }, [data]);

  if (err) {
    return (
      <div className="font-mono text-[12px] text-[var(--fg-2)]">
        todos · {err}
      </div>
    );
  }
  if (!data || !grouped) {
    return (
      <div className="font-mono text-[12px] text-[var(--fg-2)] tracking-[0.30em] uppercase">
        todos · loading
      </div>
    );
  }

  const isUrgent = tab === "urgency";
  const titleText = isUrgent ? "重要" : "待辦事項";
  const titleColor = isUrgent ? "rgba(255,110,70,1)" : "var(--fg-1)";

  return (
    <section
      className="relative flex flex-col min-w-0 min-h-0 overflow-hidden h-full"
      aria-label="vault todos"
      data-tauri-drag-region
    >
      {/* Left accent stripe — warm vertical line giving the panel a slight
          visual weight without breaking the transparent aesthetic. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: -14,
          top: 6,
          bottom: 6,
          width: 1.5,
          background:
            "linear-gradient(to bottom, rgba(255,184,120,0.55) 0%, rgba(255,184,120,0.18) 70%, rgba(255,184,120,0) 100%)",
          boxShadow:
            "0 0 6px rgba(255,184,120,0.35), 0 0 14px rgba(255,184,120,0.15)",
          borderRadius: 1,
          pointerEvents: "none",
        }}
      />
      {/* Header — title itself is the toggle. Click to flip between
          待辦事項 (category groups) ↔ 重要 (flat urgency view).
          Right slot reserved for the next round of tabs (TBD). */}
      <header className="flex items-center justify-between gap-4 font-mono flex-shrink-0 pb-4 mb-1">
        <button
          type="button"
          onClick={() => setTab(isUrgent ? "category" : "urgency")}
          className="flex items-baseline gap-3 text-[12px] tracking-[0.30em] uppercase cursor-pointer select-none"
          style={{
            color: titleColor,
            fontWeight: 500,
            background: "none",
            border: "none",
            padding: 0,
            textShadow: isUrgent ? "0 0 8px rgba(255,110,70,0.55)" : "none",
            transition: "color 280ms, text-shadow 280ms",
          }}
        >
          <span>{titleText}</span>
          <span style={{ opacity: 0.4 }}>—</span>
          <span className="tabular-nums">{data.items.length}</span>
        </button>
        {/* Right slot — future tabs */}
        <nav className="flex items-center gap-1" />
      </header>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 pr-2 -mr-2 hub-scrollbar">
      <AnimatePresence mode="wait">
        {tab === "category" ? (
          <motion.div
            key="category"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="space-y-6 pb-6"
          >
            {grouped.categories.slice(0, 12).map((g, gi) => {
              const startIdx = grouped.categories
                .slice(0, gi)
                .reduce((acc, x) => acc + Math.min(x.todos.length, 4), 0);
              const isAiBucket = g.category === "AI 待分類";
              return (
                <GroupBlock
                  key={g.category}
                  title={g.category}
                  count={g.todos.length}
                  color={isAiBucket ? "rgba(160,200,255,0.85)" : "var(--fg-1)"}
                  todos={g.todos.slice(0, 4)}
                  startIndex={startIdx}
                />
              );
            })}
          </motion.div>
        ) : (
          <motion.div
            key="urgency"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="space-y-2.5 pb-6"
          >
            {/* Flat list sorted by urgency — no sub-labels per user request */}
            {(["high", "med", "low"] as Urgency[])
              .flatMap((u) => grouped.byUrgency[u].slice(0, 8))
              .map((t, i) => (
                <TodoItem key={`${t.file}:${t.lineNum}`} t={t} index={i} />
              ))}
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </section>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative font-mono text-[11px] tracking-[0.22em] uppercase px-3 py-1 transition-colors"
      style={{
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        background: "transparent",
        border: "none",
        cursor: "pointer",
      }}
    >
      {label}
      {active ? (
        <motion.span
          layoutId="todo-tab-underline"
          className="absolute bottom-0 left-0 right-0"
          style={{
            height: 1,
            background: "rgba(255,255,255,0.5)",
          }}
        />
      ) : null}
    </button>
  );
}
