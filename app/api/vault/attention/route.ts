/**
 * GET /api/vault/attention?days=7
 *
 * Yen's attention-of-the-week, bucketed by Zone (using his own phenomenology
 * — library / septic / workshop / writing / trading / queue / …). Library
 * counts by BOOK not chapter (chaptered files under raw/ aggregate to their
 * book root directory). Septic, workshop, writing etc. count by file.
 *
 * "Opened recently" = file is in Obsidian's lastOpenFiles list (~47 items).
 * For library, a book counts as opened if ANY of its chapters is opened.
 *
 * The data is the mirror — bare numbers, no editorial spin.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  bookKey,
  cached,
  lastOpenFiles,
  statAll,
  vaultPath,
  zoneLabel,
  type FileStat,
  type Zone,
} from "@/lib/vault/reader";
import { resolveBooks } from "@/lib/vault/translate-book";

export const dynamic = "force-dynamic";

type ZoneBreakdown = {
  zone: Zone;
  label: string;
  unit: "file" | "book"; // library = book, everything else = file
  total: number; // size of the zone (books for library, files otherwise)
  added: number; // entered the zone within window
  opened: number; // touched by Obsidian recently
  hoardRatio: number | null; // added / opened
};

type BookSummary = {
  name: string; // raw folder name — kept for client lookup compatibility
  path: string;
  chapters: number;
  addedChapters: number;
  openedChapters: number;
  furthestChapter?: { num: number; title: string } | null;
  // Server-resolved display (static map + AI fallback). Use these directly.
  displayTitle?: string;
  displayAuthor?: string;
};

type AttentionResponse = {
  window: number;
  generatedAt: number;
  zones: ZoneBreakdown[];
  library: {
    activelyReading: BookSummary[]; // any chapter opened recently
    newlyHoarded: BookSummary[]; // added this window, zero opens
    books: BookSummary[]; // every book in library — for "remind me" UI
  };
};

type ChapterRef = { num: number; title: string };

/** Parse a chapter filename like `003_01 取向.md` or `001_前言.md`. */
function parseChapterFile(relPath: string): ChapterRef | null {
  const base = (relPath.split("/").pop() ?? "").replace(/\.md$/, "");
  // Format A: NNN_CC title (sequence + chapter number + title)
  const m1 = base.match(/^(\d+)_(\d+)\s+(.+)$/);
  if (m1) return { num: Number(m1[2]), title: m1[3].trim() };
  // Format B: NNN title (no chapter number — use sequence as chapter)
  const m2 = base.match(/^(\d+)_(.+)$/);
  if (m2) return { num: Number(m2[1]), title: m2[2].trim() };
  return null;
}

function bookSummaries(libFiles: FileStat[], openSet: Set<string>, cutoff: number) {
  const books = new Map<
    string,
    {
      name: string;
      path: string;
      chapters: number;
      addedChapters: number;
      openedChapters: number;
      openedRefs: ChapterRef[];
    }
  >();
  for (const f of libFiles) {
    // Skip files that don't belong to a structured book — these are usually
    // processing artifacts (`full.md`, `_NNN_part.md`, `_ch1_raw.md`) sitting
    // at the book-directory root, not real books we want to surface.
    const key = bookKey(f.rel);
    if (!key) continue;
    let b = books.get(key);
    if (!b) {
      const name = key.split("/").pop() ?? key;
      b = {
        name,
        path: key,
        chapters: 0,
        addedChapters: 0,
        openedChapters: 0,
        openedRefs: [],
      };
      books.set(key, b);
    }
    b.chapters++;
    if (f.mtimeMs >= cutoff) b.addedChapters++;
    if (openSet.has(f.rel)) {
      b.openedChapters++;
      const ref = parseChapterFile(f.rel);
      if (ref) b.openedRefs.push(ref);
    }
  }
  // Compute furthestChapter per book (highest chapter num among opened).
  return Array.from(books.values()).map((b) => {
    const sorted = [...b.openedRefs].sort((a, z) => z.num - a.num);
    const furthest = sorted[0] ?? null;
    return {
      name: b.name,
      path: b.path,
      chapters: b.chapters,
      addedChapters: b.addedChapters,
      openedChapters: b.openedChapters,
      furthestChapter: furthest,
    };
  });
}

async function build(days: number): Promise<AttentionResponse> {
  const root = vaultPath();
  const [stats, openSet] = await Promise.all([
    statAll(root),
    lastOpenFiles(root),
  ]);
  const cutoff = Date.now() - days * 86_400_000;

  const libFiles = stats.filter((s) => s.zone === "library");
  const allBooks = bookSummaries(libFiles, openSet, cutoff);

  const ZONES: Zone[] = [
    "library",
    "septic",
    "workshop",
    "writing",
    "trading",
    "queue",
    "drafts",
    "indexes",
    "derived",
    "other",
  ];

  const zones: ZoneBreakdown[] = ZONES.map((z) => {
    if (z === "library") {
      const total = allBooks.length;
      const added = allBooks.filter((b) => b.addedChapters > 0).length;
      const opened = allBooks.filter((b) => b.openedChapters > 0).length;
      return {
        zone: z,
        label: zoneLabel(z),
        unit: "book",
        total,
        added,
        opened,
        hoardRatio: opened > 0 ? added / opened : added > 0 ? null : 0,
      };
    }
    const inZone = stats.filter((s) => s.zone === z);
    const added = inZone.filter((s) => s.mtimeMs >= cutoff).length;
    const opened = inZone.filter((s) => openSet.has(s.rel)).length;
    return {
      zone: z,
      label: zoneLabel(z),
      unit: "file",
      total: inZone.length,
      added,
      opened,
      hoardRatio: opened > 0 ? added / opened : added > 0 ? null : 0,
    };
  });

  // Resolve display names for every book — static map first, then cache,
  // then AI fallback if ANTHROPIC_API_KEY is set. Runs in parallel and is
  // memoized at the route's `cached()` wrapper (5-min TTL).
  const translations = await resolveBooks(allBooks.map((b) => b.name));
  const enrich = (b: (typeof allBooks)[number]): BookSummary => {
    const t = translations[b.name];
    return {
      ...b,
      displayTitle: t?.title,
      displayAuthor: t?.author,
    };
  };
  const enrichedBooks = allBooks.map(enrich);

  const activelyReading = enrichedBooks
    .filter((b) => b.openedChapters > 0)
    .sort((a, b) => b.openedChapters - a.openedChapters);

  const newlyHoarded = enrichedBooks
    .filter((b) => b.addedChapters > 0 && b.openedChapters === 0)
    .sort((a, b) => b.addedChapters - a.addedChapters);

  const remaining = enrichedBooks
    .filter(
      (b) =>
        !activelyReading.includes(b) && !newlyHoarded.includes(b),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const books = [...activelyReading, ...newlyHoarded, ...remaining];

  return {
    window: days,
    generatedAt: Date.now(),
    zones,
    library: { activelyReading, newlyHoarded, books },
  };
}

export async function GET(req: Request) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const url = new URL(req.url);
  const days = Math.max(
    1,
    Math.min(90, Number(url.searchParams.get("days") ?? "7")),
  );
  try {
    const data = await cached(`attention:${days}`, () => build(days));
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
