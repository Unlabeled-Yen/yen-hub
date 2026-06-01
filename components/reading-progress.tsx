"use client";

/**
 * ReadingProgress — full-width book progress grid below the chart row.
 *
 * Reads /api/vault/attention (cached server-side) and renders the
 * `library.activelyReading` set in a responsive grid: each book is a
 * self-contained block with title (lead) / author (secondary) / progress
 * bar + percentage (visual encoding). Cool teal progress fill — distinct
 * from the attention chart's warm severity palette.
 *
 * Graphic-design pass:
 *   - Hierarchy: title > author > meta (size + color contrast)
 *   - Alignment: percentage / chapter count right-aligned, progress bars
 *     span full block width
 *   - Whitespace: gap-y-7 between books vertically; gap-x-10 between cols
 *   - Section divider above is generous (mt-14, pt-10) — clear breathing
 *     room separating it from whatever's above
 */

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseBook as parseBookShared } from "@/lib/vault/book-translations";

type BookSummary = {
  name: string;
  path: string;
  chapters: number;
  addedChapters: number;
  openedChapters: number;
  furthestChapter?: { num: number; title: string } | null;
  displayTitle?: string;
  displayAuthor?: string;
};

type AttentionResponse = {
  library: {
    activelyReading: BookSummary[];
    newlyHoarded: BookSummary[];
    books?: BookSummary[]; // full list — preferred when present
  };
};

const EASE: [number, number, number, number] = [0.075, 0.82, 0.165, 1];

// Re-export parseBook under a local alias so existing call sites don't change.
const parseBook = parseBookShared;

function BookBlock({ b, index }: { b: BookSummary; index: number }) {
  // Prefer server-resolved title/author (which already went through the AI
  // fallback). Fall back to client-side parsing if server didn't supply.
  const fromServer =
    b.displayTitle !== undefined
      ? { title: b.displayTitle, author: b.displayAuthor || null }
      : null;
  const { author, title } = fromServer ?? parseBook(b.name);
  const pct = b.chapters === 0 ? 0 : b.openedChapters / b.chapters;
  const pctLabel = `${Math.round(pct * 100)}%`;
  // Choreography: cube barrel-roll runs t=0→1.3s (no delay; cube spins
  // during the page fade-in so user doesn't see a static cube before
  // motion starts). Then progress bars pen-draw, last bar landing on
  // T_END = 3.5s.
  // delay  = 1.3 + i * 0.04
  // bar starts at delay + 0.15 (lead)
  // bar dur = 1.77
  // For i=7: 1.3 + 0.28 + 0.15 + 1.77 = 3.50 ✓
  const delay = 1.3 + index * 0.04;

  // Three visual states:
  //   reading: opened > 0 chapters → full brightness, teal progress
  //   queued:  added this week, not opened → slightly dimmed, "未開始" hint
  //   shelved: in library, not opened, not new → most dimmed, no hint
  const isReading = b.openedChapters > 0;
  const isQueued = !isReading && b.addedChapters > 0;
  const titleOpacity = isReading ? 1 : isQueued ? 0.7 : 0.55;

  // Status line text + color — always rendered so every book has the SAME
  // 4-row footprint (title / author / status / progress).
  let statusText = "";
  let statusColor = "var(--fg-2)";
  if (isReading) {
    statusColor = "rgba(140,220,200,0.85)";
    statusText = pct >= 1
      ? "已完讀"
      : b.furthestChapter
        ? `看到第 ${b.furthestChapter.num} 章 · ${b.furthestChapter.title}`
        : `看了 ${b.openedChapters} 章`;
  } else if (isQueued) {
    statusColor = "rgba(255,184,120,0.7)";
    statusText = `新進 ${b.addedChapters} ch`;
  } else {
    statusColor = "var(--fg-2)";
    statusText = `${b.chapters} ch`;
  }

  return (
    // No article fade-in — books need to be VISIBLE during the cube
    // barrel-roll, otherwise the cube spins around empty faces and the
    // user just sees a blank panel until bars start drawing. The cube
    // rotation IS the entry visual; bars then draw on the settled face.
    <article className="font-mono">
      {/* Row 1: title alone (no inline counter — moved to status row) */}
      <h4
        className="text-[13px] leading-tight truncate"
        style={{ color: "var(--fg-0)", opacity: titleOpacity }}
      >
        {title}
      </h4>

      {/* Row 2: author — always rendered (transparent if missing) to keep
          all books at identical vertical footprint */}
      <div
        className="text-[10px] tracking-[0.06em] mt-0.5 truncate"
        style={{
          color: "var(--fg-2)",
          opacity: author ? (isReading ? 1 : 0.7) : 0,
          minHeight: "1em",
        }}
      >
        {author ?? " "}
      </div>

      {/* Row 3: status — always rendered, fixed height */}
      <div
        className="text-[10px] mt-1 tracking-[0.04em] truncate"
        style={{ color: statusColor, minHeight: "1em" }}
      >
        {statusText}
      </div>

      {/* Row 4: progress bar + percentage.
          For non-reading books we DON'T draw the track — its 6% white left a
          thin horizontal ghost line under titles that read as visual noise.
          Keep the layout box (height 3 + flex-1) so all 8 books still align. */}
      <div className="mt-2 flex items-center gap-3">
        <span
          className="relative flex-1"
          style={{
            // 1.1× of the original 3px — per Yen's tuning. Tiny bump,
            // makes the bar a touch more present without breaking the
            // hierarchy with the title/author lines above.
            height: 3.3,
            background: isReading ? "rgba(255,255,255,0.06)" : "transparent",
            borderRadius: 1.65,
            overflow: "hidden",
          }}
        >
          {isReading ? (
            <motion.span
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(2, pct * 100)}%` }}
              transition={{ duration: 1.77, ease: EASE, delay: delay + 0.15 }}
              style={{
                display: "block",
                height: "100%",
                background: "rgba(140,220,200,0.85)",
                borderRadius: 1.5,
              }}
            />
          ) : null}
        </span>
        <span
          className="text-[10px] text-[var(--fg-2)] tabular-nums"
          style={{ minWidth: "3em", textAlign: "right" }}
        >
          {isReading ? pctLabel : "—"}
        </span>
      </div>
    </article>
  );
}

export function ReadingProgress() {
  const [data, setData] = useState<AttentionResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/vault/attention?days=7", {
          credentials: "same-origin",
        });
        if (!r.ok) return;
        const json = (await r.json()) as AttentionResponse;
        if (!cancelled) setData(json);
      } catch {
        /* swallow — show nothing on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;
  return <ReadingCube data={data} />;
}

// --- 3D rolling cube ------------------------------------------------------
const BOOKS_PER_FACE = 8;
const COLUMNS_PER_FACE = 2; // two vertical columns, 4 books each
const FACE_COUNT = 4;
const ROTATION_DURATION = 1.4;
const SWIPE_COOLDOWN_MS = 1100; // > rotation duration to avoid mid-anim retrigger
const SWIPE_THRESHOLD = 24; // pixels of horizontal scroll to count as a swipe
const CUBE_HEIGHT = 380; // explicit cube container height — sized so the
// 4th row of books (8 books per face, 2 cols × 4 rows) has full breathing
// room for its progress bar. 340px was clipping the bottom row's bar.

function ReadingCube({ data }: { data: AttentionResponse }) {
  const allBooks = data.library.books ?? data.library.activelyReading;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cooldownRef = useRef(0);
  // How many pages have at least one book — wheel handler reads this via
  // ref so it doesn't need to re-bind every render. Updated by an effect
  // below once we compute the real page array.
  const populatedRef = useRef(1);
  // Entrance flag — true after the cube barrel-roll finishes. Cube
  // starts spinning immediately at mount (no delay) so the rotation is
  // visible DURING the page-level opacity fade-in instead of after it.
  // Spin dur = 1.3s; page fade = 1.1s, so the cube is still rotating
  // when the page reaches full opacity → user perceives entry as one
  // continuous motion rather than "page appears, pause, then spin."
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 1350);
    return () => clearTimeout(t);
  }, []);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 470, h: 360 });
  const [face, setFace] = useState(0);

  // Measure container so cube depth follows actual width
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const r = node.getBoundingClientRect();
      if (r.width > 0) setSize({ w: r.width, h: r.height });
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  // Manual swipe — trackpad two-finger horizontal swipe (wheel deltaX).
  // No more auto-rotate; user is in full control.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      // Only react when horizontal intent dominates (deltaX > deltaY).
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 0.8) return;
      if (Math.abs(e.deltaX) < SWIPE_THRESHOLD) return;
      e.preventDefault();
      const now = performance.now();
      if (now < cooldownRef.current) return;
      cooldownRef.current = now + SWIPE_COOLDOWN_MS;
      // Swipe left → next face; swipe right → previous face.
      // Wrap within POPULATED page range so empty trailing faces never
      // appear. populatedRef is updated below by an effect — using a ref
      // keeps this handler stable (no re-bind on every face change).
      const dir = e.deltaX > 0 ? 1 : -1;
      const populated = populatedRef.current || 1;
      setFace((f) => (f + dir + populated) % populated);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);


  // Build pages then drop empty trailing ones — e.g. if user only has 20
  // books, page 4 (books 24..31) is empty and shouldn't take a face. The
  // cube still uses 4 geometric faces internally (FACE_COUNT) so the
  // rotation arithmetic stays clean; we just clamp navigation + dots to
  // the populated faces.
  const pages = useMemo(() => {
    const out: BookSummary[][] = [];
    for (let i = 0; i < FACE_COUNT; i++) {
      out.push(allBooks.slice(i * BOOKS_PER_FACE, (i + 1) * BOOKS_PER_FACE));
    }
    return out;
  }, [allBooks]);
  const populatedPageCount = pages.filter((p) => p.length > 0).length;
  useEffect(() => {
    populatedRef.current = populatedPageCount;
  }, [populatedPageCount]);

  // If current face index drifted past the populated range (e.g. data
  // shrank), snap back. Effect runs after render but before paint so the
  // dots/header counter stay in sync.
  useEffect(() => {
    if (face >= populatedPageCount && populatedPageCount > 0) {
      setFace(0);
    }
  }, [populatedPageCount, face]);

  if (allBooks.length === 0) return null;

  const readingCount = data.library.activelyReading.length;
  const depth = Math.max(200, size.w / 2);

  return (
    <section className="flex flex-col">
      <header className="flex-shrink-0 flex items-baseline gap-4 mb-5 font-mono text-[11px] tracking-[0.30em] uppercase text-[var(--fg-2)]">
        <span>閱讀進度</span>
        <span style={{ opacity: 0.4 }}>—</span>
        <span className="tabular-nums">
          <span style={{ color: "var(--fg-0)" }}>{readingCount}</span>
          {" / "}
          {allBooks.length}
        </span>
        <span
          style={{
            opacity: 0.5,
            marginLeft: "auto",
            fontSize: 9,
            letterSpacing: "0.16em",
          }}
        >
          ← swipe → · {face + 1}/{populatedPageCount}
        </span>
      </header>

      <div
        ref={containerRef}
        className="relative overflow-hidden"
        style={{ perspective: 1800, height: CUBE_HEIGHT }}
      >
        {/* Outer wrapper pushes the cube center BACK by `depth` so the active
            face lands exactly on the container's z = 0 plane (perspective
            distance), keeping its rendered size 1:1 with container width.
            Without this, the active face pops forward and perspective scales
            it ~19% larger → content overflows + clips horizontally. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            transformStyle: "preserve-3d",
            transform: `translateZ(-${depth}px)`,
          }}
        >
          <motion.div
            // Entrance: exactly ONE full turn, then settle on the
            // active face. Uses a KEYFRAMES array (not a single value)
            // because framer-motion's interpolator normalizes single-
            // value rotations to their shortest arc — so e.g.
            // `initial: -360, animate: 0` would compress to no
            // movement at all. Keyframes force the actual path.
            // After `entered`, face changes use the slower
            // user-driven rotation curve (single value, no keyframes).
            initial={{ rotateY: -360 }}
            animate={
              entered
                ? { rotateY: -face * 90 }
                : { rotateY: [-360, -face * 90] }
            }
            transition={
              entered
                ? { duration: ROTATION_DURATION, ease: [0.65, 0, 0.35, 1] }
                : { duration: 1.3, ease: [0.16, 1, 0.3, 1] }
            }
            style={{
              position: "absolute",
              inset: 0,
              transformStyle: "preserve-3d",
            }}
          >
            {pages.map((pageBooks, faceIndex) => (
              <div
                key={faceIndex}
                style={{
                  position: "absolute",
                  inset: 0,
                  transform: `rotateY(${faceIndex * 90}deg) translateZ(${depth}px)`,
                  backfaceVisibility: "hidden",
                  // Left-flush the book grid (was "8px 12px"). Keeps the
                  // right-side breathing room but pulls the leftmost
                  // column up to the face's left edge per Yen's spec.
                  padding: "8px 12px 8px 0",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-start",
                  overflow: "hidden",
                }}
              >
                <div
                  className="grid gap-x-6 gap-y-3"
                  style={{
                    gridTemplateColumns: `repeat(${COLUMNS_PER_FACE}, minmax(0, 1fr))`,
                    // CSS Grid fills row-by-row by default. We want column-first
                    // (fill column 1 with books 0..3, then column 2 with 4..7)
                    // so visual reading order goes vertically per column.
                    gridAutoFlow: "column",
                    gridTemplateRows: `repeat(${BOOKS_PER_FACE / COLUMNS_PER_FACE}, auto)`,
                  }}
                >
                  {pageBooks.map((b, i) => (
                    <BookBlock key={b.path} b={b} index={i} />
                  ))}
                </div>
              </div>
            ))}
          </motion.div>
        </div>
      </div>

      {/* Face indicator dots removed per spec — header counter (1/3) is
          the sole position indicator. */}
    </section>
  );
}
