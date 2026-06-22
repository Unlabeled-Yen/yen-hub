/**
 * Timezone anchor for all schedule math — Asia/Taipei.
 *
 * Why a fixed offset and not Intl: Taiwan has not observed daylight saving
 * since 1979, so Asia/Taipei is a constant UTC+08:00. A fixed offset lets the
 * cron matcher extract wall-clock fields with plain getUTC* arithmetic instead
 * of an `Intl.DateTimeFormat` call per iteration — the matcher walks up to
 * ~527k minutes in the worst case (cron-utils.ts), so per-iteration Intl would
 * be a real cost.
 *
 * Why anchor at all (vs the previous `Date.get*` system-local approach): the
 * old code read minute/hour/day-of-week off the SYSTEM timezone. On Yen's Mac
 * that happens to be Taipei, so it worked — but it silently breaks if the
 * laptop travels, and it makes dev/CI (which usually run in UTC) compute a
 * different cron/fire schedule than production. Anchoring to Taipei explicitly
 * makes the behavior deterministic everywhere and matches the authoritative
 * `[現在時間]` block Duffy already injects in Asia/Taipei (see agent.ts).
 *
 * If Yen ever needs a configurable zone, swap the constant for an
 * `Intl`-backed offset lookup keyed on a zone string — call sites use the
 * helpers below, not the constant, so they won't change.
 */

export const TAIPEI_OFFSET_MIN = 8 * 60;

/** Wall-clock fields of an instant, evaluated in Asia/Taipei. */
export type WallClock = {
  year: number;
  /** 1–12 */
  month: number;
  /** day-of-month 1–31 */
  dom: number;
  hour: number;
  minute: number;
  /** 0=Sunday … 6=Saturday (cron DOW convention) */
  dow: number;
};

/**
 * A `Date` whose UTC fields equal the Taipei wall clock of `epochMs`. Use its
 * `getUTC*` / `setUTC*` methods to read or mutate Taipei-local time (setUTCDate
 * handles month/year rollover correctly), then convert back with
 * `fromTaipeiShifted`.
 */
export function taipeiShifted(epochMs: number): Date {
  return new Date(epochMs + TAIPEI_OFFSET_MIN * 60_000);
}

/** Inverse of `taipeiShifted` — real epoch ms from a Taipei-shifted Date. */
export function fromTaipeiShifted(shifted: Date): number {
  return shifted.getTime() - TAIPEI_OFFSET_MIN * 60_000;
}

/** Read the Asia/Taipei wall-clock fields of an instant. */
export function taipeiWallClock(epochMs: number): WallClock {
  const d = taipeiShifted(epochMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    dom: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

/** `YYYY-MM-DD` for the Asia/Taipei calendar day of an instant. Use for
 *  daily-keyed state (journal file name, "fired today" de-dupe) so a UTC-run
 *  process and a Taipei-run process agree on which day it is. */
export function taipeiDateStr(epochMs: number): string {
  const wc = taipeiWallClock(epochMs);
  const m = String(wc.month).padStart(2, "0");
  const day = String(wc.dom).padStart(2, "0");
  return `${wc.year}-${m}-${day}`;
}
