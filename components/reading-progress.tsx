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
import { useEffect, useMemo, useRef, useState, type ElementType, type MouseEvent as ReactMouseEvent } from "react";
import { parseBook as parseBookShared } from "@/lib/vault/book-translations";
import { EASE } from "@/lib/animation/constants";
import type {
  AttentionResponse,
  BookSummary,
} from "@/lib/vault/attention-types";

// Re-export parseBook under a local alias so existing call sites don't change.
const parseBook = parseBookShared;

/**
 * Build an `obsidian://open` deep link for a chapter file. Returns null if
 * either the vault name or target path is missing (e.g. legacy payload).
 * `file` query param does NOT need the trailing `.md` — Obsidian resolves
 * it — but URI-encoding the slashes IS required so spaces/CJK survive.
 */
function obsidianUrl(vaultName: string | undefined, target: string | null | undefined): string | null {
  if (!vaultName || !target) return null;
  const file = target.replace(/\.md$/, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

function BookBlock({
  b,
  index,
  vaultName,
}: {
  b: BookSummary;
  index: number;
  vaultName: string | undefined;
}) {
  // Prefer server-resolved title/author (which already went through the AI
  // fallback). Fall back to client-side parsing if server didn't supply.
  const fromServer =
    b.displayTitle !== undefined
      ? { title: b.displayTitle, author: b.displayAuthor || null }
      : null;
  const { author, title } = fromServer ?? parseBook(b.name);
  // Progress percentage uses ONLY openedChapters (Obsidian-tracked
  // reading). addedChapters (mtime within window — usually agent
  // processing) is a secondary signal: it only contributes to whether
  // the book is rendered as "active" in the cube, never to the
  // numerical % — otherwise a book Landy translated 64 chapters of
  // would read as "已完讀" even though Yen hasn't opened a chapter.
  const pct = b.chapters === 0 ? 0 : b.openedChapters / b.chapters;
  const pctLabel = `${Math.round(pct * 100)}%`;
  // Choreography: half-turn cube flip runs t=0→1.6s (no delay; spins
  // during the page fade-in). Then progress bars pen-draw, last bar
  // landing on T_END = 3.5s.
  // delay  = 1.6 + i * 0.04
  // bar starts at delay + 0.15 (lead)
  // bar dur = 1.47
  // For i=7: 1.6 + 0.28 + 0.15 + 1.47 = 3.50 ✓
  const delay = 1.6 + index * 0.04;

  // Visual states.
  //   reading:    opened > 0  → full brightness, teal progress, real chapter info
  //   processing: opened = 0, added > 0  → mid brightness, warm hint ("處理過 N 章")
  //   shelved:    neither     → dimmed, "{chapters} ch" only
  const isReading = b.openedChapters > 0;
  const isProcessing = !isReading && b.addedChapters > 0;
  const titleOpacity = isReading ? 1 : isProcessing ? 0.75 : 0.55;

  // Status line text + color — always rendered so every book has the SAME
  // 4-row footprint (title / author / status / progress).
  let statusText = "";
  let statusColor = "var(--fg-2)";
  if (isReading) {
    statusColor = "rgba(140,220,200,0.85)";
    if (pct >= 1) {
      statusText = "已完讀";
    } else {
      statusText = b.furthestChapter
        ? `看到第 ${b.furthestChapter.num} 章 · ${b.furthestChapter.title}`
        : `看了 ${b.openedChapters} 章`;
    }
  } else if (isProcessing) {
    // mtime-only activity — agent processing / translating / cleanup.
    // Distinct from reading: no per-chapter "I read this" signal exists.
    statusColor = "rgba(255,184,120,0.7)";
    statusText = `處理過 ${b.addedChapters} 章`;
  } else {
    statusColor = "var(--fg-2)";
    statusText = `${b.chapters} ch`;
  }

  const href = obsidianUrl(vaultName, b.openTarget);

  // No article fade-in — books need to be VISIBLE during the cube
  // barrel-roll, otherwise the cube spins around empty faces and the
  // user just sees a blank panel until bars start drawing. The cube
  // rotation IS the entry visual; bars then draw on the settled face.
  //
  // Click → open in Obsidian via Tauri's shell plugin. Anchor-based
  // navigation + window.open both get swallowed silently by the
  // WKWebView for custom URL schemes (verified in dev). The shell
  // plugin's `open()` calls into macOS's URL handler explicitly, which
  // does fire Obsidian. Scope is locked to `obsidian://*` in
  // src-tauri/capabilities/default.json.
  const handleClick =
    href && typeof window !== "undefined"
      ? async (e: ReactMouseEvent) => {
          e.preventDefault();
          try {
            // tauri-plugin-opener: Tauri 2's URL-opening plugin. The
            // shell plugin's `open` has a hardcoded scope that rejects
            // anything other than http(s)/mailto/tel — so we use opener
            // instead, with `obsidian://*` whitelisted in
            // src-tauri/capabilities/default.json. The capability also
            // needs `remote.urls` pointing at http://127.0.0.1:* so it
            // applies to the sidecar-loaded webview, not just local.
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(href);
          } catch {
            // Dev fallback: outside the Tauri runtime (e.g. plain
            // browser on localhost:3000), the plugin import throws.
            // window.open does work in a normal browser for custom
            // schemes registered with the OS.
            window.open(href, "_blank");
          }
        }
      : undefined;

  const Wrapper: ElementType = href ? "a" : "article";
  const wrapperProps = href
    ? {
        href,
        onClick: handleClick,
        className: "font-mono group block cursor-pointer no-underline",
        title: "在 Obsidian 開啟",
      }
    : { className: "font-mono group" };

  return (
    <Wrapper {...wrapperProps}>
      {/* Row 1: title alone (no inline counter — moved to status row) */}
      <h4
        className="text-[13px] leading-tight truncate transition-colors group-hover:underline"
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
              transition={{ duration: 1.47, ease: EASE, delay: delay + 0.15 }}
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
    </Wrapper>
  );
}

export function ReadingProgress({
  data,
}: {
  /** Parent (Overview) fetches once and passes here. See AttentionGrid
   *  for the same prop — they share the payload so the vault fs isn't
   *  scanned twice. null = still loading. */
  data: AttentionResponse | null;
}) {
  if (!data) return null;
  // Show the cube whenever the library has ANY book — not only when there
  // are "actively reading" books. Obsidian's `lastOpenFiles` only keeps
  // ~50 most-recently-touched paths; if the user has been editing Queue
  // notes for a few days, every library chapter rotates out, and the
  // cube would silently disappear despite the vault still being full of
  // tracked books. Drawing 0%-progress bars is the honest signal: "you
  // have these books, you haven't opened a chapter recently."
  const total =
    data.library.books?.length ?? data.library.activelyReading.length;
  if (total === 0) return null;
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
    const t = setTimeout(() => setEntered(true), 1650);
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

  // Header counter = books with actual Obsidian reading activity (matches
  // ReadingBlock's `isReading` logic so the number and the bright tiles
  // stay in sync). Books that only show "處理過 N 章" (agent processing)
  // are visible in the cube but don't count toward "閱讀進度" — that
  // number is reserved for what Yen has actually opened.
  const readingCount = allBooks.filter((b) => b.openedChapters > 0).length;
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
            // Entrance: HALF turn (180°) — Yen wanted less rotation
            // and a more languid feel. Combined with the slower 1.6s
            // duration below this reads as a calm "page flip" rather
            // than a barrel roll. Keyframes still required because
            // framer-motion normalizes single-value rotateY to its
            // shortest arc.
            initial={{ rotateY: -180 }}
            animate={
              entered
                ? { rotateY: -face * 90 }
                : { rotateY: [-180, -face * 90] }
            }
            transition={
              entered
                ? { duration: ROTATION_DURATION, ease: [0.65, 0, 0.35, 1] }
                : { duration: 1.6, ease: [0.16, 1, 0.3, 1] }
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
                    <BookBlock
                      key={b.path}
                      b={b}
                      index={i}
                      vaultName={data.vaultName}
                    />
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
