"use client";

/**
 * TodoList — Page A 右半的待辦事項面板。
 *
 * 兩個 tab：
 *   - 種類：按 zone 分組（Yen Hub / AI建造 / 寫作草稿 / 佇列 / …）
 *   - 急迫：按 file mtime 分三級（< 3 天=急、3-14=中、> 14=低）
 *
 * 點 item → SVG 手寫筆跡橫劃過文字 → 高度塌陷消失。完成狀態存到
 * local overlay（done-store），下次 GET 自動過濾。Header 右側「同步」
 * 鈕把完成項寫回 vault .md。
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

type TodosResponse = { items: Todo[]; doneCount: number };

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
  onComplete,
}: {
  t: Todo;
  index: number;
  onComplete: (t: Todo) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "striking" | "done">("idle");
  const [rects, setRects] = useState<LineRect[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const textRef = useRef<HTMLSpanElement>(null);
  const firedRef = useRef(false);

  function handleClick() {
    if (phase !== "idle" || firedRef.current) return;
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
    setPhase("striking");
    firedRef.current = true;
    // Let the SVG render + animate. Total: ~600ms stroke + ~50ms breath.
    window.setTimeout(() => setPhase("done"), 680);
    window.setTimeout(() => onComplete(t), 980);
  }

  const strikePath = useMemo(() => buildStrikePath(rects), [rects]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -4, height: "auto" }}
      animate={
        phase === "done"
          ? { opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }
          : { opacity: phase === "striking" ? 0.55 : 1, x: 0 }
      }
      transition={
        phase === "done"
          ? { duration: 0.3, ease: EASE }
          : { duration: 0.45, delay: index * 0.025, ease: EASE }
      }
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
      style={{ overflow: "hidden" }}
    >
      <div className="relative text-[12px] text-[var(--fg-0)] leading-snug break-words transition-colors group-hover:text-[var(--fg-1)]">
        <span ref={textRef}>{trunc(t.text, 90)}</span>
        {phase === "striking" && rects.length > 0 ? (
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
              initial={{ pathLength: 0, opacity: 0.9 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: 0.6, ease: [0.22, 0.9, 0.36, 1] }}
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
  onComplete,
}: {
  title: string;
  count: number;
  color: string;
  todos: Todo[];
  startIndex: number;
  onComplete: (t: Todo) => void;
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
        <AnimatePresence initial={false}>
          {todos.map((t, i) => (
            <TodoItem
              key={todoId(t)}
              t={t}
              index={startIndex + i}
              onComplete={onComplete}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function TodoList() {
  const [data, setData] = useState<TodosResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("category");
  const [completedKeys, setCompletedKeys] = useState<Set<string>>(new Set());
  const [doneCount, setDoneCount] = useState(0);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncFlash, setSyncFlash] = useState<string | null>(null);

  async function fetchTodos() {
    try {
      const r = await fetch("/api/vault/todos", { credentials: "same-origin" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const json = (await r.json()) as TodosResponse;
      setData(json);
      setDoneCount(json.doneCount ?? 0);
      setCompletedKeys(new Set());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    fetchTodos();
  }, []);

  function onComplete(t: Todo) {
    const id = todoId(t);
    setCompletedKeys((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setDoneCount((c) => c + 1);
    fetch("/api/vault/todos/complete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: t.file,
        lineNum: t.lineNum,
        text: t.text,
      }),
    }).catch(() => {
      /* swallow — overlay write is best-effort; next reload will rescan */
    });
  }

  async function syncToVault() {
    if (syncBusy || doneCount === 0) return;
    if (!window.confirm(`同步 ${doneCount} 條完成項寫回 vault .md？`)) return;
    setSyncBusy(true);
    setSyncFlash(null);
    try {
      const r = await fetch("/api/vault/todos/sync", {
        method: "POST",
        credentials: "same-origin",
      });
      const body = (await r.json()) as {
        written?: number;
        skipped?: number;
        remaining?: number;
        error?: string;
      };
      if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`);
      setSyncFlash(
        `寫回 ${body.written ?? 0}，略過 ${body.skipped ?? 0}`,
      );
      setDoneCount(body.remaining ?? 0);
      window.setTimeout(() => setSyncFlash(null), 2400);
      await fetchTodos();
    } catch (e) {
      setSyncFlash(e instanceof Error ? e.message : String(e));
      window.setTimeout(() => setSyncFlash(null), 3500);
    } finally {
      setSyncBusy(false);
    }
  }

  const grouped = useMemo(() => {
    if (!data) return null;
    const items = data.items.filter((t) => !completedKeys.has(todoId(t)));

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

    return { categories, byUrgency, visibleCount: items.length };
  }, [data, completedKeys]);

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
          <span className="tabular-nums">{grouped.visibleCount}</span>
        </button>
        {/* Sync chip — appears only when there are completed items in the
            overlay waiting to be written back to vault .md. */}
        <nav className="flex items-center gap-2">
          {syncFlash ? (
            <span
              className="text-[10px] tracking-[0.18em] uppercase"
              style={{ color: "rgba(180,200,180,0.85)" }}
            >
              {syncFlash}
            </span>
          ) : null}
          {doneCount > 0 ? (
            <button
              type="button"
              onClick={syncToVault}
              disabled={syncBusy}
              className="text-[10px] tracking-[0.20em] uppercase font-mono px-2 py-1"
              style={{
                color: syncBusy
                  ? "var(--fg-2)"
                  : "rgba(255,184,120,0.95)",
                border: "1px solid rgba(255,184,120,0.35)",
                borderRadius: 2,
                background: "rgba(255,184,120,0.04)",
                cursor: syncBusy ? "wait" : "pointer",
                transition: "color 200ms, border-color 200ms, background 200ms",
              }}
              title={`寫回 ${doneCount} 條完成 TODO 到 vault`}
            >
              ⇪ sync · {doneCount}
            </button>
          ) : null}
        </nav>
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
                    onComplete={onComplete}
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
              <AnimatePresence initial={false}>
                {(["high", "med", "low"] as Urgency[])
                  .flatMap((u) => grouped.byUrgency[u].slice(0, 8))
                  .map((t, i) => (
                    <TodoItem
                      key={todoId(t)}
                      t={t}
                      index={i}
                      onComplete={onComplete}
                    />
                  ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
