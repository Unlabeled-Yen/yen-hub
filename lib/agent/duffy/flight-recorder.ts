/**
 * Flight recorder — Slice 14 (yen-hub runtime tape into Glasshouse).
 *
 * Writes every meaningful Duffy event into Glasshouse's events tape so
 * Glasshouse becomes a true "戰況地圖" (battle-map), not just a
 * "build-time architecture map".
 *
 * Why: tonight (2026-06-13) revealed that Glasshouse only recorded
 * code-modification events (Claude Code hook). Duffy's runtime behavior
 * was invisible — every bug required "tail the dev terminal" gymnastics.
 * This recorder closes that gap.
 *
 * Design rules:
 *   - NEVER block Duffy. All writes are best-effort, swallowed errors.
 *   - Append-only. One JSONL line per event.
 *   - Routes to glasshouse/events/yen-hub-runtime.jsonl.
 *   - Source tag "duffy-runtime" — condenser will filter this out of
 *     analyzer input by default (don't pollute architecture inference).
 *
 * Read by: human (tail the file), future "AI flight log" feature in
 * Glasshouse, debug scripts.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Hard-code Glasshouse path. If Glasshouse ever moves this needs to update
// (acceptable — Glasshouse repo is named in CLAUDE.md and stable).
const TAPE_PATH = join(
  homedir(),
  "Desktop",
  "Yen",
  "Develop",
  "glasshouse",
  "events",
  "yen-hub-runtime.jsonl",
);

export type FlightEventType =
  | "prompt-built"
  | "tool-call"
  | "tool-result"
  | "response-finished"
  | "error";

export function recordRuntime(
  type: FlightEventType,
  data: Record<string, unknown>,
): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: "duffy-runtime",
      type,
      ...data,
    });
    appendFileSync(TAPE_PATH, line + "\n");
  } catch {
    /* recorder must never block Duffy — silent on failure */
  }
}
