/**
 * Minimal cron parser — Slice 11.
 *
 * Supports the standard 5-field cron expression with these atoms per field:
 *   *           — any value
 *   N           — exact number
 *   A-B         — inclusive range
 *   *\/N         — every N (starting from field minimum)
 *   A,B,C       — list
 *
 * No external dep — keeps Yen Hub zero-config. If we ever outgrow this,
 * swap in `cron-parser` from npm without touching call sites.
 *
 * Day-of-week: 0 = Sunday .. 6 = Saturday. 7 is accepted as alias for 0.
 * Day-of-month and day-of-week: standard cron OR semantics (either matches).
 */

import { taipeiWallClock } from "./tz";

type FieldName = "minute" | "hour" | "dom" | "month" | "dow";

const FIELD_BOUNDS: Record<FieldName, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dow: { min: 0, max: 6 },
};

function parseAtom(atom: string, name: FieldName): Set<number> {
  const { min, max } = FIELD_BOUNDS[name];
  const out = new Set<number>();

  const normalize = (n: number): number => {
    if (name === "dow" && n === 7) return 0;
    return n;
  };

  const parts = atom.split(",");
  for (const part of parts) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let body = part;
    let step = 1;
    if (stepMatch) {
      body = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`invalid step in ${name} field: ${part}`);
      }
    }

    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map((s) => parseInt(s, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(`invalid range in ${name} field: ${body}`);
      }
      lo = a;
      hi = b;
    } else {
      const n = parseInt(body, 10);
      if (!Number.isFinite(n)) {
        throw new Error(`invalid number in ${name} field: ${body}`);
      }
      lo = n;
      hi = n;
    }

    for (let i = lo; i <= hi; i += step) {
      const v = normalize(i);
      if (v < min || v > max) {
        throw new Error(
          `value ${i} out of bounds for ${name} (${min}-${max})`,
        );
      }
      out.add(v);
    }
  }
  return out;
}

export type ParsedCron = {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  /** true when both dom and dow are restricted (i.e. neither is "*"). */
  domDowAnd: boolean;
  /** Original expression for echoing back. */
  expr: string;
};

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields (got ${parts.length}): "${expr}"`,
    );
  }
  return {
    minutes: parseAtom(parts[0], "minute"),
    hours: parseAtom(parts[1], "hour"),
    doms: parseAtom(parts[2], "dom"),
    months: parseAtom(parts[3], "month"),
    dows: parseAtom(parts[4], "dow"),
    domDowAnd: parts[2] !== "*" && parts[4] !== "*",
    expr,
  };
}

// Cron fields are matched against the Asia/Taipei wall clock (see tz.ts), NOT
// the system timezone. This keeps fire times stable across travel and makes
// dev/CI (usually UTC) agree with production.
function matches(p: ParsedCron, epochMs: number): boolean {
  const wc = taipeiWallClock(epochMs);
  if (!p.minutes.has(wc.minute)) return false;
  if (!p.hours.has(wc.hour)) return false;
  if (!p.months.has(wc.month)) return false;
  const dom = p.doms.has(wc.dom);
  const dow = p.dows.has(wc.dow);
  // Standard cron OR semantics: if either dom or dow is "*", AND-match;
  // if both restricted, OR-match (so "0 8 1 * 1" fires on the 1st OR on Mondays).
  return p.domDowAnd ? dom || dow : dom && dow;
}

// Iterate by absolute epoch ms (not Date.setMinutes, which moves in SYSTEM
// local time and can skip/repeat across a system-local DST seam). Taipei has a
// whole-hour offset, so a minute boundary in UTC is also a minute boundary in
// Taipei — flooring to 60_000 ms aligns both.
const MINUTE_MS = 60_000;
const MAX_ITER = 366 * 24 * 60;

/** Next fire strictly after `from`. Throws if none within 1 year. */
export function nextFire(p: ParsedCron, from: Date): Date {
  // Next whole-minute boundary strictly after `from`.
  let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < MAX_ITER; i++) {
    if (matches(p, t)) return new Date(t);
    t += MINUTE_MS;
  }
  throw new Error(`no fire time within 1 year for "${p.expr}"`);
}

/** Last fire at-or-before `at`. Used by scheduler to detect missed fires
 *  (laptop slept, server crashed). Throws if none in last year. */
export function prevFire(p: ParsedCron, at: Date): Date {
  // Current whole-minute boundary at-or-before `at`.
  let t = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let i = 0; i < MAX_ITER; i++) {
    if (matches(p, t)) return new Date(t);
    t -= MINUTE_MS;
  }
  throw new Error(`no fire time within last year for "${p.expr}"`);
}

/* -------------------------------------------------------------------------- */
/*  Human-friendly description — used by UI live preview                       */
/* -------------------------------------------------------------------------- */

const DOW_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** Heuristic "describe in plain zh" for common cron shapes. Falls back to
 *  the raw expression when the shape isn't recognised. */
export function describeCron(expr: string): string {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return expr;
    const [m, h, dom, mo, dow] = parts;
    const pad = (n: string) => n.padStart(2, "0");

    // Daily at fixed time
    if (mo === "*" && dom === "*" && dow === "*" && /^\d+$/.test(m) && /^\d+$/.test(h)) {
      return `每天 ${pad(h)}:${pad(m)}`;
    }
    // Weekly at fixed time
    if (mo === "*" && dom === "*" && /^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dow)) {
      const d = parseInt(dow, 10) % 7;
      return `每週${DOW_ZH[d]} ${pad(h)}:${pad(m)}`;
    }
    // Hourly
    if (mo === "*" && dom === "*" && dow === "*" && h === "*" && /^\d+$/.test(m)) {
      return `每小時 ${pad(m)} 分`;
    }
    // Every N minutes
    if (mo === "*" && dom === "*" && dow === "*" && h === "*" && m.startsWith("*/")) {
      return `每 ${m.slice(2)} 分鐘`;
    }
    // Every N hours
    if (mo === "*" && dom === "*" && dow === "*" && m === "0" && h.startsWith("*/")) {
      return `每 ${h.slice(2)} 小時`;
    }
    return expr;
  } catch {
    return expr;
  }
}

/** Returns the minimum interval (in minutes) between successive fires of
 *  this cron expression. Used to enforce a "no more frequent than 1 hour"
 *  rule at approval time. */
export function minIntervalMinutes(p: ParsedCron): number {
  // Cheap approach: scan next ~24h of fires, take min gap. Good enough for
  // the typical patterns Yen will use.
  const start = new Date();
  start.setSeconds(0, 0);
  let prev = nextFire(p, start);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 100; i++) {
    const nxt = nextFire(p, prev);
    const gap = (nxt.getTime() - prev.getTime()) / 60_000;
    if (gap < min) min = gap;
    if (nxt.getTime() - start.getTime() > 24 * 60 * 60 * 1000) break;
    prev = nxt;
  }
  return Number.isFinite(min) ? Math.round(min) : 60;
}
