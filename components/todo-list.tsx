"use client";

/**
 * TodoList — Page A 右半的代辦面板。標題點擊 = 切換三個視圖：
 *
 *   1. 首要代辦 (priority)  ← 預設
 *      使用者親自從「總覽代辦」勾選的子集。**橘紅劃記功能只在此頁可用**：
 *      點 item → 切換 done strike (overlay 持久化)。
 *   2. 總覽代辦 (category)
 *      所有 active (≤ 7 天) 的代辦，按 category 分組顯示。
 *      點 item → toggle priority (overlay 持久化)；之後該 item 會出現在
 *      首要代辦頁。
 *   3. 審查 (review)
 *      > 7 天的代辦，不會出現在首要與總覽兩頁，只在此頁。
 *      讀取為主，不接受點擊互動。
 *
 * Hover 2 秒功能、深 hover pill 等都保留 (在哪一頁都看得到)。
 */

import { motion, AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EASE } from "@/lib/animation/constants";

type Todo = {
  file: string;
  lineNum: number;
  text: string;
  zone: string;
  category: string;
  needsAi: boolean;
  mtimeMs: number;
};

type TodosResponse = {
  items: Todo[];
  doneKeys: string[];
  priorityKeys: string[];
};

const OLD_DAYS = 7;

type Tab = "priority" | "category" | "review";
const TAB_ORDER: Tab[] = ["priority", "category", "review"];
const TAB_LABEL: Record<Tab, string> = {
  priority: "首要代辦",
  category: "總覽代辦",
  review: "審查",
};
const TAB_COLOR: Record<Tab, string> = {
  priority: "rgba(255,110,70,1)", // warm red — high attention
  category: "var(--fg-1)",
  review: "rgba(160,180,210,0.92)", // cool blue-gray — calm "look at this"
};
const TAB_SHADOW: Record<Tab, string> = {
  priority: "0 0 8px rgba(255,110,70,0.55)",
  category: "none",
  review: "0 0 8px rgba(160,180,210,0.35)",
};

function isOld(t: Todo): boolean {
  return (Date.now() - t.mtimeMs) / 86_400_000 >= OLD_DAYS;
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
      return `M ${x0} ${y} Q ${mid} ${y - 1.6} ${x1} ${y}`;
    })
    .join(" ");
}

type ClickMode = "strike" | "promote" | "none";

// Global entry sync target — every panel's intro ends at T_END seconds.
// Reading cube (3.50) and AttentionGrid pen (3.50) all converge here so
// the page reads as one breath instead of three separate openings.
const T_END = 3.5;

// Short fade + long stagger — each item snaps in individually but
// with a clear gap between items, not a slow blur.
const FADE_BASELINE_MS = 400;
const FADE_STAGGER_MS = 450;
const STAGGER_CAP = 15;
const FADE_DUR = 0.35;

function TodoItem({
  t,
  index,
  isDone,
  isPriority,
  clickMode,
  entryPhase,
  onToggleDone,
  onTogglePriority,
}: {
  t: Todo;
  index: number;
  isDone: boolean;
  isPriority: boolean;
  clickMode: ClickMode;
  // True only during the page's first ~T_END seconds. When true, each
  // item types in (clip-path inset shrinking right→left) with its own
  // duration tuned so it ENDS at T_END — earlier items take longer,
  // later items take shorter, all finishing together.
  // When false (tab switches after entry), use the regular short fade.
  entryPhase: boolean;
  onToggleDone: (t: Todo, next: boolean) => void;
  onTogglePriority: (t: Todo, next: boolean) => void;
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

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    if (textRef.current) ro.observe(textRef.current);
    return () => ro.disconnect();
  }, []);

  function handleClick() {
    if (clickMode === "none" || busy) return;
    setBusy(true);
    if (clickMode === "strike") {
      // Force a fresh measure right before flipping done. After the
      // typewriter pass, the outer span's content layout sometimes
      // hadn't been recaptured (ResizeObserver doesn't always fire on
      // inline span changes), leaving `rects` stuck at a stale partial
      // state — which made the strike path render as a single tiny
      // segment at the start of the text. Remeasuring synchronously
      // here guarantees the path covers the full current text rects.
      measure();
      onToggleDone(t, !isDone);
    } else if (clickMode === "promote") {
      onTogglePriority(t, !isPriority);
    }
    window.setTimeout(() => setBusy(false), 500);
  }

  const strikePath = useMemo(() => buildStrikePath(rects), [rects]);

  // In Priority view, struck items dim text + show pen stroke.
  // In Overview, priority-marked items get a subtle warm dot indicator.
  // In Review, no decoration; read-only.
  const dimText = clickMode === "strike" && isDone;
  const showStrike = clickMode === "strike" && isDone && rects.length > 0;
  const showPriorityDot = clickMode === "promote" && isPriority;
  const clickable = clickMode !== "none";

  // Fade-in stagger. Stagger drops to a tiny step after the first
  // STAGGER_CAP items so long lists don't take forever.
  const cappedI = Math.min(index, STAGGER_CAP);
  const overflowI = Math.max(0, index - STAGGER_CAP);
  const itemBase =
    FADE_BASELINE_MS + cappedI * FADE_STAGGER_MS + overflowI * 80;
  const bodyText = trunc(t.text, 90);
  const fileText = fileName(t.file);
  const daysText = dayLabel(t.mtimeMs);
  // Typewriter cancelled per Yen. Body / filename / days ALL share
  // the same simple opacity fade-in pattern (same as the original
  // days-ago animation). One delay per item; the three texts fade in
  // together at fadeDelaySec.
  const fadeDelaySec = entryPhase ? itemBase / 1000 : 0;

  return (
    <div
      onClick={handleClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`font-mono min-w-0 select-none group ${clickable ? "cursor-pointer" : ""}`}
    >
      <div className="relative text-[12px] leading-snug break-words flex items-start gap-2">
        {showPriorityDot ? (
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              marginTop: 5,
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "rgba(255,110,70,0.9)",
              boxShadow: "0 0 5px rgba(255,110,70,0.5)",
            }}
          />
        ) : null}
        <div className="relative min-w-0 flex-1">
          {/* Body span doubles as the strike-path anchor (textRef +
              measure()). Simple opacity fade-in (matching days-ago).
              The textRef stays on the inline <span> so the strike
              measurement still works. */}
          <motion.span
            ref={textRef}
            initial={entryPhase ? { opacity: 0 } : { opacity: dimText ? 0.55 : 1 }}
            animate={{ opacity: dimText ? 0.55 : 1 }}
            transition={{ duration: FADE_DUR, ease: EASE, delay: fadeDelaySec }}
            style={{
              color: dimText ? "var(--fg-2)" : "var(--fg-0)",
              display: "inline",
            }}
          >
            {bodyText}
          </motion.span>
          {showStrike ? (
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
                animate={{ pathLength: 1, opacity: 1 }}
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
      </div>
      <div className="text-[10px] text-[var(--fg-2)] mt-1 flex items-center gap-2 min-w-0 pl-[1px]">
        {/* All three sub-row pieces share the same fade-in pattern as
            days-ago — typewriter cancelled per Yen. */}
        <motion.span
          className="truncate flex-1 min-w-0"
          initial={entryPhase ? { opacity: 0 } : { opacity: 1 }}
          animate={{ opacity: 1 }}
          transition={{ duration: FADE_DUR, ease: EASE, delay: fadeDelaySec }}
        >
          {fileText}
        </motion.span>
        <motion.span
          initial={entryPhase ? { opacity: 0 } : { opacity: 0.5 }}
          animate={{ opacity: 0.5 }}
          transition={{ duration: FADE_DUR, ease: EASE, delay: fadeDelaySec }}
        >
          ·
        </motion.span>
        <motion.span
          className="tabular-nums whitespace-nowrap"
          initial={entryPhase ? { opacity: 0 } : { opacity: 1 }}
          animate={{ opacity: 1 }}
          transition={{ duration: FADE_DUR, ease: EASE, delay: fadeDelaySec }}
        >
          {daysText}
        </motion.span>
      </div>
    </div>
  );
}

function GroupBlock({
  title,
  count,
  color,
  todos,
  startIndex,
  doneKeys,
  priorityKeys,
  clickMode,
  entryPhase,
  onToggleDone,
  onTogglePriority,
}: {
  title: string;
  count: number;
  color: string;
  todos: Todo[];
  startIndex: number;
  doneKeys: Map<string, string>;
  priorityKeys: Map<string, string>;
  clickMode: ClickMode;
  entryPhase: boolean;
  onToggleDone: (t: Todo, next: boolean) => void;
  onTogglePriority: (t: Todo, next: boolean) => void;
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
            isPriority={priorityKeys.has(todoId(t))}
            clickMode={clickMode}
            entryPhase={entryPhase}
            onToggleDone={onToggleDone}
            onTogglePriority={onTogglePriority}
          />
        ))}
      </div>
    </div>
  );
}

export function TodoList() {
  const [data, setData] = useState<TodosResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("priority");
  const [doneMap, setDoneMap] = useState<Map<string, string>>(new Map());
  const [priorityMap, setPriorityMap] = useState<Map<string, string>>(new Map());
  // Gate rendering until the SHA-1 hashing for doneKeys / priorityKeys
  // has run for every item. Without this gate, the first paint after
  // fetch shows data but with priorityMap STILL empty → priorityPool is
  // empty → the placeholder "尚未挑選首要代辦 / 點標題切到「總覽代辦」"
  // flashes briefly, and Yen reads the "總覽代辦" in the placeholder
  // text as a tab swap. Holding "loading" until both data AND keys are
  // ready eliminates that flash entirely.
  const [keysReady, setKeysReady] = useState(false);
  // Typewriter entry phase. Starts true; flips false ~T_END after the
  // FIRST mount of real items (so a slow fetch doesn't shift the timing
  // window past page load). Tab switches after that use the normal fade.
  const [entryPhase, setEntryPhase] = useState(true);
  const entryArmedRef = useRef(false);
  useEffect(() => {
    // Arm when BOTH data and keysReady are true — that's when items
    // actually render and the typewriter starts. Arming earlier would
    // burn the 12s timer during SHA-1 hashing while nothing is visible.
    if (!data || !keysReady || entryArmedRef.current) return;
    entryArmedRef.current = true;
    // Cover the longest fade-in chain (slower per Yen):
    //   baseline 500ms + 12*120ms = 1940ms + 700ms fade = 2.64s.
    // Add buffer; after flip, newly-mounted items (tab switch) render
    // instantly.
    const id = window.setTimeout(() => setEntryPhase(false), 25_000);
    return () => window.clearTimeout(id);
  }, [data, keysReady]);

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

        const doneSet = new Set(json.doneKeys ?? []);
        const prioritySet = new Set(json.priorityKeys ?? []);
        const nextDone = new Map<string, string>();
        const nextPriority = new Map<string, string>();
        await Promise.all(
          json.items.map(async (t) => {
            const full = await sha1Hex(`${t.file}\n${t.text}`);
            const k = full.slice(0, 16);
            if (doneSet.has(k)) nextDone.set(todoId(t), k);
            if (prioritySet.has(k)) nextPriority.set(todoId(t), k);
          }),
        );
        if (!cancelled) {
          setDoneMap(nextDone);
          setPriorityMap(nextPriority);
          setKeysReady(true);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggleDone(t: Todo, next: boolean) {
    const id = todoId(t);
    setDoneMap((prev) => {
      const m = new Map(prev);
      if (next) m.set(id, m.get(id) ?? "pending");
      else m.delete(id);
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
      /* swallow */
    }
  }

  async function onTogglePriority(t: Todo, next: boolean) {
    const id = todoId(t);
    setPriorityMap((prev) => {
      const m = new Map(prev);
      if (next) m.set(id, m.get(id) ?? "pending");
      else m.delete(id);
      return m;
    });
    try {
      await fetch("/api/vault/todos/priority", {
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
      /* swallow */
    }
  }

  // Tab cycling:
  //   Single click → toggle between priority ↔ category. Quick everyday
  //   path between the two main work surfaces.
  //   Double click → jump to 審查 (review). Behind a deliberate gesture
  //   so it doesn't appear in the casual cycle.
  // Implementation: schedule the single-click action on a short timer;
  // a second click within the window cancels the timer and triggers
  // the double-click action instead.
  const clickTimerRef = useRef<number | null>(null);
  function onTitleClick() {
    if (clickTimerRef.current !== null) return; // double-handler will fire
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      // ANY tab switch ends the entry effect — other tabs (總覽 / 審查)
      // should never replay the typewriter even on first visit. Doing
      // this BEFORE setTab ensures the freshly-mounted items in the
      // new tab read entryPhase=false on their first render.
      setEntryPhase(false);
      setTab((prev) => {
        // Single-click target: priority ↔ category. From review goes
        // back to priority (the default surface).
        if (prev === "priority") return "category";
        return "priority";
      });
    }, 240);
  }
  function onTitleDoubleClick() {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setEntryPhase(false); // see onTitleClick comment
    setTab("review");
  }
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  // Pool computation -------------------------------------------------
  const items = data?.items ?? [];
  const active = items.filter((t) => !isOld(t));
  const reviewPool = items.filter((t) => isOld(t));
  const priorityPool = active.filter((t) => priorityMap.has(todoId(t)));

  // Category grouping for the Overview tab.
  const categoryGroups = useMemo(() => {
    if (!data) return null;
    const byCategory = new Map<string, Todo[]>();
    for (const t of active) {
      const arr = byCategory.get(t.category) ?? [];
      arr.push(t);
      byCategory.set(t.category, arr);
    }
    const sorted = Array.from(byCategory.entries())
      .map(([cat, ts]) => ({ category: cat, todos: ts }))
      .sort((a, b) => {
        if (a.category === "AI 待分類") return 1;
        if (b.category === "AI 待分類") return -1;
        return b.todos.length - a.todos.length;
      });
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, priorityMap]);

  if (err) {
    return (
      <div className="font-mono text-[12px] text-[var(--fg-2)]">
        todos · {err}
      </div>
    );
  }
  if (!data || !keysReady) {
    // Return null instead of a "todos · loading" string. Yen reported
    // seeing the English loading text flash before the panel suddenly
    // resets to "首要代辦" with the typewriter. Rendering nothing keeps
    // the panel area blank during the ~100ms load → no jarring switch
    // from "loading" markup to the full panel markup. The wrapper in
    // overview.tsx reserves the height via readingH so the page layout
    // doesn't shift either.
    return null;
  }

  const titleText = TAB_LABEL[tab];
  const titleColor = TAB_COLOR[tab];
  const titleShadow = TAB_SHADOW[tab];
  let displayCount = 0;
  if (tab === "priority") displayCount = priorityPool.length;
  else if (tab === "category") displayCount = active.length;
  else displayCount = reviewPool.length;

  const clickMode: ClickMode =
    tab === "priority" ? "strike" : tab === "category" ? "promote" : "none";

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
          onClick={onTitleClick}
          onDoubleClick={onTitleDoubleClick}
          className="flex items-baseline gap-3 text-[12px] tracking-[0.30em] uppercase cursor-pointer select-none"
          style={{
            color: titleColor,
            fontWeight: 500,
            background: "none",
            border: "none",
            padding: 0,
            textShadow: titleShadow,
            transition: "color 280ms, text-shadow 280ms",
          }}
          title="單擊切換首要 / 總覽，雙擊進入審查"
        >
          {/* Panel title — original effect per Yen: simple opacity
              fade-in, no typewriter. The wrapping motion.span lets
              this fade independently of the (removed) wrapper fade. */}
          <motion.span
            initial={entryPhase ? { opacity: 0 } : { opacity: 1 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, ease: EASE }}
            style={{ display: "inline-block" }}
          >
            {titleText}
          </motion.span>
          <span style={{ opacity: 0.4 }}>—</span>
          <span className="tabular-nums">{displayCount}</span>
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
              {categoryGroups?.slice(0, 12).map((g, gi) => {
                const startIdx = (categoryGroups || [])
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
                    priorityKeys={priorityMap}
                    clickMode={clickMode}
                    entryPhase={entryPhase}
                    onToggleDone={onToggleDone}
                    onTogglePriority={onTogglePriority}
                  />
                );
              })}
            </motion.div>
          ) : tab === "priority" ? (
            <motion.div
              key="priority"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="space-y-2.5 pb-6"
            >
              {priorityPool.length === 0 ? (
                <div
                  className="font-mono text-[11px] text-[var(--fg-2)] leading-relaxed"
                  style={{ opacity: 0.7 }}
                >
                  尚未挑選首要代辦
                  <br />
                  <span style={{ opacity: 0.6 }}>
                    點標題切到「總覽代辦」，選取重要項目即可加入這裡
                  </span>
                </div>
              ) : (
                priorityPool
                  .slice(0, 30)
                  .map((t, i) => (
                    <TodoItem
                      key={todoId(t)}
                      t={t}
                      index={i}
                      isDone={doneMap.has(todoId(t))}
                      isPriority={true}
                      clickMode={clickMode}
                      entryPhase={entryPhase}
                      onToggleDone={onToggleDone}
                      onTogglePriority={onTogglePriority}
                    />
                  ))
              )}
            </motion.div>
          ) : (
            <motion.div
              key="review"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="space-y-2.5 pb-6"
            >
              {reviewPool.length === 0 ? (
                <div
                  className="font-mono text-[11px] text-[var(--fg-2)]"
                  style={{ opacity: 0.7 }}
                >
                  暫無需要審查的代辦 (超過 7 天)
                </div>
              ) : (
                reviewPool
                  .slice(0, 30)
                  .map((t, i) => (
                    <TodoItem
                      key={todoId(t)}
                      t={t}
                      index={i}
                      isDone={doneMap.has(todoId(t))}
                      isPriority={priorityMap.has(todoId(t))}
                      clickMode={clickMode}
                      entryPhase={entryPhase}
                      onToggleDone={onToggleDone}
                      onTogglePriority={onTogglePriority}
                    />
                  ))
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
