/**
 * Shared types for /api/vault/attention. AttentionGrid and
 * ReadingProgress both consume this payload — the canonical type lives
 * here so they read off the same shape.
 */

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

export type Zone =
  | "library"
  | "septic"
  | "workshop"
  | "yenhub"
  | "writing"
  | "trading"
  | "queue"
  | "indexes"
  | "derived"
  | "drafts"
  | "other";

export type ZoneBreakdown = {
  zone: Zone;
  label: string;
  unit: "file" | "book";
  total: number;
  added: number;
  opened: number;
  hoardRatio: number | null;
};

export type AttentionResponse = {
  window: number;
  generatedAt: number;
  zones: ZoneBreakdown[];
  library: {
    activelyReading: BookSummary[];
    newlyHoarded: BookSummary[];
    books?: BookSummary[];
  };
};
