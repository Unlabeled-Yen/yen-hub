/**
 * Attention data builder — extracted from `app/api/vault/attention/route.ts`
 * so tools / agents can read the same data without going through HTTP +
 * cookie auth. The route now imports `buildAttention` from here.
 *
 * The cache wrapper (`cached`) is shared across callers, so the API route
 * and Duffy's `read_attention_state` tool hit the same memoised result.
 */

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

export type ZoneBreakdown = {
  zone: Zone;
  label: string;
  unit: "file" | "book";
  total: number;
  added: number;
  opened: number;
  hoardRatio: number | null;
};

export type BookSummary = {
  name: string;
  path: string;
  chapters: number;
  addedChapters: number;
  openedChapters: number;
  furthestChapter?: { num: number; title: string } | null;
  displayTitle?: string;
  displayAuthor?: string;
};

export type AttentionResponse = {
  window: number;
  generatedAt: number;
  zones: ZoneBreakdown[];
  library: {
    activelyReading: BookSummary[];
    newlyHoarded: BookSummary[];
    books: BookSummary[];
  };
};

type ChapterRef = { num: number; title: string };

function parseChapterFile(relPath: string): ChapterRef | null {
  const base = (relPath.split("/").pop() ?? "").replace(/\.md$/, "");
  const m1 = base.match(/^(\d+)_(\d+)\s+(.+)$/);
  if (m1) return { num: Number(m1[2]), title: m1[3].trim() };
  const m2 = base.match(/^(\d+)_(.+)$/);
  if (m2) return { num: Number(m2[1]), title: m2[2].trim() };
  return null;
}

function bookSummaries(
  libFiles: FileStat[],
  openSet: Set<string>,
  cutoff: number,
) {
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

async function buildAttentionUncached(days: number): Promise<AttentionResponse> {
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
      (b) => !activelyReading.includes(b) && !newlyHoarded.includes(b),
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

/** Cached entry point — share the same memoization with the API route. */
export async function buildAttention(days: number): Promise<AttentionResponse> {
  return cached(`attention:${days}`, () => buildAttentionUncached(days));
}
