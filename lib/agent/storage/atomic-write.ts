/**
 * Storage durability primitives — shared by the JSON-overlay stores under
 * `~/Library/Application Support/com.yen.hub/`.
 *
 * Two problems these solve, both verified in the existing stores:
 *
 * 1. **Corruption on crash** — the naked stores did
 *    `fs.writeFile(FILE, JSON.stringify(mem))`, which truncates-then-writes
 *    the real file. A crash (or `signal 9`, which this app has a history of —
 *    see CLAUDE.md) mid-write leaves a half-written, unparseable JSON and the
 *    ENTIRE store — every intent / observation / conversation — is gone.
 *    `atomicWriteJson` writes a temp sibling then `rename()`s it over the
 *    target. POSIX rename is atomic: a reader either sees the whole old file
 *    or the whole new one, never a torn one. This is the same pattern the
 *    NEWER stores already use (schedules.ts / trust-config.ts) — this just
 *    makes it reusable so the older stores stop hand-rolling raw writes.
 *
 * 2. **Lost update on concurrent mutation** — the stores do
 *    `m = await load()` → mutate → `await save()`. Two overlapping calls in
 *    the same module instance both `load()`, mutate, and write; whoever writes
 *    last wins and the other's mutation vanishes (the documented
 *    silhouettes.ts stale-`mem` bug, but the same shape lived in intents /
 *    observations / conversations). `withStoreLock` serializes the WHOLE
 *    load→mutate→write transaction per file path, so they run one at a time.
 *
 * Scope note: both mechanisms are per-process. In Next standalone, API routes
 * and `instrumentation.ts` bundle SEPARATE instances of these modules (see the
 * load() comments in every store), so a cross-instance lost update is still
 * possible. But `atomicWriteJson`'s rename means the worst case there is a
 * lost update, NOT a corrupted file — which is exactly the bound we want until
 * a real DB (SQLite/Turso) lands. Closing the cross-instance window needs a
 * filesystem lock (e.g. an O_EXCL lockfile) or the DB migration; out of scope.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/* -------------------------------------------------------------------------- */
/*  Per-file transaction lock                                                 */
/* -------------------------------------------------------------------------- */

// One promise chain per file path. Each queued transaction awaits the prior
// one (success OR failure — we never let a rejected link break the chain).
const chains = new Map<string, Promise<unknown>>();

/**
 * Serialize an async transaction against a file path. Use this to wrap the
 * full load→mutate→write critical section of a store mutation so concurrent
 * callers can't interleave and clobber each other.
 *
 * IMPORTANT — no re-entrancy: a function running inside `withStoreLock(F, …)`
 * must never call another `withStoreLock(F, …)` for the SAME file F, or it
 * self-deadlocks (the inner call waits for the outer to finish, which is
 * waiting for the inner). Keep critical sections to JUST the read-mutate-write;
 * do external/expensive work (materialize, network, cross-file writes) OUTSIDE
 * the lock. Locks on DIFFERENT files may nest safely as long as the acquisition
 * order is consistent across the codebase.
 */
export function withStoreLock<T>(
  file: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(file) ?? Promise.resolve();
  // Run `fn` after the prior link settles, regardless of its outcome.
  const run = prev.then(fn, fn);
  // Tail used as the next link's predecessor — swallow so a failed transaction
  // doesn't reject the chain for everyone behind it.
  chains.set(
    file,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/* -------------------------------------------------------------------------- */
/*  Atomic JSON write                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Write `data` as pretty JSON to `file` atomically (temp sibling + rename).
 * Creates the parent dir if missing. Throws on failure (callers that want the
 * old best-effort behavior should wrap in try/catch and log — see
 * `persistJson`).
 */
export async function atomicWriteJson(
  file: string,
  data: unknown,
): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  // Unique temp name so two writers (or a previous crashed write) can't collide
  // on the same temp path. pid + time + random is plenty for a single host.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    // Don't leave temp droppings behind on failure.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Best-effort atomic write that never throws — replaces the old
 * `try { writeFile } catch { /* swallow *\/ }` blocks. Same durability as
 * `atomicWriteJson`, but a failure is now OBSERVABLE (logged with the file and
 * error) instead of silently dropping the user's data. Returns whether the
 * write landed, so callers can react if they want.
 */
export async function persistJson(
  file: string,
  data: unknown,
): Promise<boolean> {
  try {
    await atomicWriteJson(file, data);
    return true;
  } catch (err) {
    console.error(
      `[storage] FAILED to persist ${file} — data for this mutation was NOT saved:`,
      err,
    );
    return false;
  }
}
