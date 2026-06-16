/**
 * Schedule resolver — pure helpers that turn structured natural inputs into
 * concrete epoch_ms / cron_expr. Created 2026-06-13 to take time math AWAY
 * from Duffy after the «5 分鐘後 → UTC 20:45» incident.
 *
 * Philosophy (ADR-0009 sibling): server owns time facts, AI owns intent.
 * Duffy says «5min» / «daily 21:00» / «once» — server resolves. Duffy never
 * touches epoch ms or 5-field cron syntax.
 *
 * All functions are pure (modulo the `now` parameter you can inject for tests).
 */

/** Day-of-week to cron-DOW number. cron-DOW: 0=Sunday … 6=Saturday. */
const WEEKDAY_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Resolve a relative-time phrase into absolute epoch ms.
 *
 * Accepted forms (case-insensitive):
 *   - Pure relative: "5min" / "30min" / "1h" / "2h" / "1h30min" / "2d" / "1d12h"
 *   - Today/tomorrow at a wall-clock time: "today 21:00" / "tomorrow 09:00"
 *   - Next weekday at a wall-clock time: "next-mon 09:00" / "this-fri 18:00"
 *
 * Throws with a guidance message on unparseable input.
 */
export function parseRelativeTime(input: string, now: Date = new Date()): number {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) throw new Error("relative time empty");

  // Pure relative — at least one of d / h / min must be present and non-zero.
  const unitMatch = trimmed.match(
    /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*min)?$/,
  );
  if (unitMatch && (unitMatch[1] || unitMatch[2] || unitMatch[3])) {
    const days = parseInt(unitMatch[1] || "0", 10);
    const hours = parseInt(unitMatch[2] || "0", 10);
    const minutes = parseInt(unitMatch[3] || "0", 10);
    const offsetMs = ((days * 24 + hours) * 60 + minutes) * 60_000;
    if (offsetMs === 0) throw new Error("relative time resolves to zero");
    return now.getTime() + offsetMs;
  }

  // today / tomorrow + HH:MM
  const dateMatch = trimmed.match(/^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/);
  if (dateMatch) {
    const dayOffset = dateMatch[1] === "tomorrow" ? 1 : 0;
    const hour = parseInt(dateMatch[2], 10);
    const minute = parseInt(dateMatch[3], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`out-of-range time: ${hour}:${minute}`);
    }
    const target = new Date(now);
    target.setDate(target.getDate() + dayOffset);
    target.setHours(hour, minute, 0, 0);
    return target.getTime();
  }

  // this-{weekday} / next-{weekday} + HH:MM
  const wkMatch = trimmed.match(
    /^(this|next)-(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/,
  );
  if (wkMatch) {
    const targetDow = WEEKDAY_MAP[wkMatch[2]];
    const currentDow = now.getDay();
    let dayOffset = (targetDow - currentDow + 7) % 7;
    if (dayOffset === 0 && wkMatch[1] === "next") dayOffset = 7;
    const hour = parseInt(wkMatch[3], 10);
    const minute = parseInt(wkMatch[4], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`out-of-range time: ${hour}:${minute}`);
    }
    const target = new Date(now);
    target.setDate(target.getDate() + dayOffset);
    target.setHours(hour, minute, 0, 0);
    return target.getTime();
  }

  throw new Error(
    `unparseable: "${input}". Supported: "5min" / "1h30min" / "today 21:00" / "tomorrow 09:00" / "next-mon 09:00"`,
  );
}

/**
 * Resolve a recurrence phrase into a 5-field cron expression.
 *
 * Accepted forms:
 *   - "once" — single fire; uses refTime's HH:MM as the cron. Caller MUST set
 *     one_shot=true and not_before so missed-by-creation rules trigger correctly.
 *   - "daily HH:MM"
 *   - "weekly mon,wed,fri HH:MM" — any comma-separated weekday list (sun..sat)
 *   - "monthly N HH:MM" — N is day-of-month 1..28 (avoid 29-31 portability issues)
 *
 * Throws with a guidance message on unparseable input.
 */
export function parseRecurrence(input: string, refTime: Date = new Date()): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) throw new Error("recurrence empty");

  if (trimmed === "once") {
    return `${refTime.getMinutes()} ${refTime.getHours()} * * *`;
  }

  const dailyMatch = trimmed.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const minute = parseInt(dailyMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`out-of-range time: ${hour}:${minute}`);
    }
    return `${minute} ${hour} * * *`;
  }

  const weeklyMatch = trimmed.match(
    /^weekly\s+([a-z,]+)\s+(\d{1,2}):(\d{2})$/,
  );
  if (weeklyMatch) {
    const days = weeklyMatch[1]
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const n = WEEKDAY_MAP[d];
        if (n === undefined) throw new Error(`unknown weekday: ${d}`);
        return n;
      });
    if (days.length === 0) throw new Error(`weekly needs at least one day`);
    const hour = parseInt(weeklyMatch[2], 10);
    const minute = parseInt(weeklyMatch[3], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`out-of-range time: ${hour}:${minute}`);
    }
    return `${minute} ${hour} * * ${[...new Set(days)].sort().join(",")}`;
  }

  const monthlyMatch = trimmed.match(/^monthly\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (monthlyMatch) {
    const dom = parseInt(monthlyMatch[1], 10);
    const hour = parseInt(monthlyMatch[2], 10);
    const minute = parseInt(monthlyMatch[3], 10);
    if (dom < 1 || dom > 28) {
      throw new Error(`day-of-month must be 1..28 (got ${dom})`);
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`out-of-range time: ${hour}:${minute}`);
    }
    return `${minute} ${hour} ${dom} * *`;
  }

  throw new Error(
    `unparseable: "${input}". Supported: "once" / "daily 21:00" / "weekly mon,wed 09:00" / "monthly 1 09:00"`,
  );
}

/** Quick sanity guard: not_before must be within reasonable bounds. */
export function validateNotBefore(notBefore: number, now: Date = new Date()): string | null {
  const nowMs = now.getTime();
  if (notBefore < nowMs - 60_000) {
    return `not_before 在過去（${new Date(notBefore).toISOString()}），請重新計算`;
  }
  if (notBefore > nowMs + 365 * 24 * 3600_000) {
    return `not_before 超過一年後（${new Date(notBefore).toISOString()}），可能是錯的`;
  }
  return null;
}
