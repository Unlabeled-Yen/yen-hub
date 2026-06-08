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
  /**
   * Vault-relative file path that clicking on this book should open in
   * Obsidian. Furthest opened chapter if any reading has happened;
   * otherwise the first (lowest-numbered) chapter so shelved books open
   * at chapter 1. Null only if no parseable chapter file was found.
   */
  openTarget?: string | null;
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
  /**
   * Vault folder name (basename of YEN_VAULT_PATH). Used by the frontend
   * to build `obsidian://open?vault=<vaultName>&file=<path>` URLs.
   */
  vaultName: string;
  library: {
    activelyReading: BookSummary[];
    newlyHoarded: BookSummary[];
    books?: BookSummary[];
  };
};
