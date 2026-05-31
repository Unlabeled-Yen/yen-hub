"use client";

/**
 * TodoList — Page A 右半的待辦事項面板。
 *
 * 兩個 tab：
 *   - 種類：按 zone 分組（Yen Hub / AI建造 / 寫作草稿 / 佇列 / …）
 *   - 急迫：按 file mtime 分三級（< 3 天=急、3-14=中、> 14=低）
 *
 * 點 TODO → SVG 手寫筆跡劃過文字（toggle，再點一次取消）。劃記狀態存到
 * local overlay（done-store），重啟後還在。vault .md 永遠不被動到。
 */

import { motion, AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

type Todo = {
  file: string;
  lineNum: number;
  text: string;
  zone: string;
  category: string;
  needsAi: boolean;
  mtimeMs: number;
};

type TodosResponse = { items: Todo[]; doneKeys: string[] };

const EASE: [number, number, number, number] = [0.075, 0.82, 0.165, 1];

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

function todoId(t: Todo): string {
  return `${t.file}:${t.lineNum}:${t.text}`;
}

// Mirror of lib/vault/done-store.ts → todoKey().
// Browser-side sha1 needed because we want optimistic isDone before API roundtrip.
async function sha1Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type LineRect = { x: number; y: number; width: number; height: number };

function buildStrikePath(rects: LineRect[]): string {
  return rects
    .map((r) => {
      const y = r.y + r.height / 2 + 0.5;
      const x0 = r.x;
      const x1 = r.x + r.width;
      const mid = r.x + r.width / 2;
      // Q curve gives a slight wobble — hand-drawn feel instead of a CAD line.
      return `M ${x0} ${y} Q ${mid} ${y - 1.6} ${x1} ${y}`;
    })
    .join(" ");
}

function TodoItem({
  t,
  index,
  isDone,
  onToggle,
}: {
  t: Todo;
  index: number;
  isDone: boolean;
  onToggle: (t: Todo, next: boolean) => void;
}) {
  const [rects, setRects] = useState<LineRect[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  function measure() {
    const el = textRef.current;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const cRect = el.getBoundingClientRect();
    const lineRects = Array.from(range.getClientRects()).map((r) => ({
      x: r.left - cRect.left,
      y: r.top - cRect.top,
      width: r.width,
      height: r.height,
    }));
    setRects(lineRects);
    setSize({ w: cRect.width, h: cRect.height });
  }

  // Measure once after mount so the strike SVG is ready whether the item
  // loads already-done or gets clicked later. Re-measure on window resize.
  useEffect(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    if (textRef.current) ro.observe(textRef.current);
    return () => ro.disconnect();
  }, []);

  function handleClick() {
    if (busy) return;
    setBusy(true);
    onToggle(t, !isDone);
    // Lockout until the strike anim finishes so rapid double-click doesn't
    // toggle mid-stroke.
    window.setTimeout(() => setBusy(false), 600);
  }

  const strikePath = useMemo(() => buildStrikePath(rects), [rects]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.45, delay: index * 0.025, ease: EASE }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      className="font-mono min-w-0 cursor-pointer select-none group"
    >
      <div className="relative text-[12px] leading-snug break-words">
        <motion.span
          ref={textRef}
          animate={{
            color: isDone
              ? "var(--fg-2)"
              : "var(--fg-0)",
            opacity: isDone ? 0.55 : 1,
          }}
          transition={{ duration: 0.35, ease: EASE }}
          style={{ display: "inline" }}
        >
          {trunc(t.text, 90)}
        </motion.span>
        {rects.length > 0 ? (
          <svg
            className="absolute inset-0 pointer-events-none"
            width={size.w}
            height={size.h}
            viewBox={`0 0 ${size.w} ${size.h}`}
            style={{ overflow: "visible" }}
            aria-hidden
          >
            <motion.path
              d={strikePath}
              stroke="rgba(255,160,90,0.95)"
              strokeWidth={1.6}
              strokeLinecap="round"
              fill="none"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{
                pathLength: isDone ? 1 : 0,
                opacity: isDone ? 1 : 0,
              }}
              transition={{
                pathLength: { duration: 0.55, ease: [0.22, 0.9, 0.36, 1] },
                opacity: { duration: 0.25, ease: EASE },
              }}
              style={{
                filter: "drop-shadow(0 0 4px rgba(255,160,90,0.45))",
              }}
            />
          </svg>
        ) : null}
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
  doneKeys,
  onToggle,
}: {
  title: string;
  count: number;
  color: string;
  todos: Todo[];
  startIndex: number;
  doneKeys: Map<string, string>; // todoId → keyHash
  onToggle: (t: Todo, next: boolean) => void;
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
          <TodoItem
            key={todoId(t)}
            t={t}
            index={startIndex + i}
            isDone={doneKeys.has(todoId(t))}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

export function TodoList() {
  const [data, setData] = useState<TodosResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("category");
  // todoId → keyHash. Membership = "currently struck through".
  const [doneMap, setDoneMap] = useState<Map<string, string>>(new Map());

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
        if (cancelled) return;
        setData(json);

        // Restore strike state: for each visible item, compute its sha1 and
        // check membership in doneKeys.
        const keySet = new Set(json.doneKeys ?? []);
        const next = new Map<string, string>();
        await Promise.all(
          json.items.map(async (t) => {
            const full = await sha1Hex(`${t.file}\n${t.text}`);
            const k = full.slice(0, 16);
            if (keySet.has(k)) next.set(todoId(t), k);
          }),
        );
        if (!cancelled) setDoneMap(next);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggle(t: Todo, next: boolean) {
    const id = todoId(t);
    // Optimistic: flip local state immediately so the SVG animates.
    setDoneMap((prev) => {
      const m = new Map(prev);
      if (next) {
        // Will be filled with the actual key once sha1 resolves (just below),
        // but for UI purposes any non-empty value triggers the strike.
        m.set(id, m.get(id) ?? "pending");
      } else {
        m.delete(id);
      }
      return m;
    });

    try {
      await fetch("/api/vault/todos/complete", {
        method: next ? "POST" : "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          file: t.file,
          lineNum: t.lineNum,
          text: t.text,
        }),
      });
    } catch {
      /* swallow — visual state already updated; next reload will reconcile */
    }
  }

  const grouped = useMemo(() => {
    if (!data) return null;
    const items = data.items;

    const byCategory = new Map<string, Todo[]>();
    for (const t of items) {
      const arr = byCategory.get(t.category) ?? [];
      arr.push(t);
      byCategory.set(t.category, arr);
    }
    const categories = Array.from(byCategory.entries())
      .map(([cat, ts]) => ({ category: cat, todos: ts }))
      .sort((a, b) => {
        if (a.category === "AI 待分類") return 1;
        if (b.category === "AI 待分類") return -1;
        return b.todos.length - a.todos.length;
      });

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
        <nav className="flex items-center gap-1" />
      </header>

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
                    color={
                      isAiBucket ? "rgba(160,200,255,0.85)" : "var(--fg-1)"
                    }
                    todos={g.todos.slice(0, 4)}
                    startIndex={startIdx}
                    doneKeys={doneMap}
                    onToggle={onToggle}
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
              {(["high", "med", "low"] as Urgency[])
                .flatMap((u) => grouped.byUrgency[u].slice(0, 8))
                .map((t, i) => (
                  <TodoItem
                    key={todoId(t)}
                    t={t}
                    index={i}
                    isDone={doneMap.has(todoId(t))}
                    onToggle={onToggle}
                  />
                ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
