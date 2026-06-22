/**
 * Trust zones — coarse risk partition for path-bearing intents.
 *
 * Slice 12 Phase 4b (2026-06-23) — auto-pilot learning was per-`kind`, so a
 * single `file_create` tier governed BOTH Duffy's sandbox writes and writes
 * into Yen's main vault. Promoting the kind to L0 from mostly-sandbox approvals
 * silently auto-executed main-vault writes too (config files, daily journal…).
 * Splitting file kinds into zones lets the sandbox earn autonomy without
 * dragging the main vault along.
 *
 * Two zones:
 *   - `workspace` — under `06 - AI Data/Duffy Workspace/` (Duffy's sandbox;
 *     already statically L0 via vault-write-tools).
 *   - `vault`     — anywhere else in Yen's vault (statically L1, gated).
 *
 * Non-path kinds (observation / schedule / summary / todo_plan…) have no zone
 * and stay governed at kind granularity — see `tierForIntent`.
 */

import type { Intent } from "./types";

export type TrustZone = "workspace" | "vault";

/** Canonical sandbox prefix. Single source of truth — vault-write-tools'
 *  static L0 decision derives from this same constant. */
export const DUFFY_WORKSPACE_PREFIX = "06 - AI Data/Duffy Workspace/";

export function isInDuffyWorkspace(path: string): boolean {
  // Normalise: strip leading slash; reject '..' escapes (defense-in-depth —
  // the materialiser also guards path traversal).
  const p = path.replace(/^\/+/, "");
  if (p.includes("..")) return false;
  return p.startsWith(DUFFY_WORKSPACE_PREFIX);
}

/** Coarse trust zone for a file path: Duffy's sandbox vs Yen's main vault. */
export function zoneForPath(path: string): TrustZone {
  return isInDuffyWorkspace(path) ? "workspace" : "vault";
}

/** Zone for an intent that writes a path (file_create / file_edit). Returns
 *  null for kinds with no path — those stay governed at kind granularity. */
export function zoneForIntent(intent: Intent): TrustZone | null {
  if (intent.kind === "file_create" || intent.kind === "file_edit") {
    const path = (intent.payload as { path?: unknown }).path;
    if (typeof path === "string") return zoneForPath(path);
  }
  return null;
}

/** Composite bucket key for per-(kind,zone) trust learning. Zoneless kinds key
 *  on the bare kind so legacy kind-level behavior is preserved. */
export function trustBucketKey(kind: string, zone: TrustZone | null): string {
  return zone ? `${kind}@${zone}` : kind;
}
