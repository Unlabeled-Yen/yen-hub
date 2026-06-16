/**
 * Per-chat in-flight mutex for Telegram Duffy turns.
 *
 * Both the Telegram poller (incoming user messages) and the schedule
 * action (proactive nightly journal-interview push) call
 * runDuffyHeadless + appendTelegramMessage on the same chat_id. If 21:00
 * fires while Yen happens to be typing, the two paths can interleave
 * writes into telegram-chats.json — Q1 lands AFTER Yen's reply, history
 * order corrupts.
 *
 * This module keeps a Map<chat_id, Promise> and chains each turn behind
 * the previous one. Cheap, in-memory, scoped to a single Node process —
 * which is correct because instrumentation.ts boots scheduler + poller
 * in the SAME process (see instrumentation.ts:20-23).
 *
 * Failure isolation: if a turn throws, the chain still resolves so the
 * next call doesn't deadlock. The throw propagates only to its own caller.
 */

const inflight = new Map<number, Promise<void>>();

export async function withTelegramTurn<T>(
  chat_id: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = inflight.get(chat_id) ?? Promise.resolve();

  let resolveNext!: () => void;
  const next = new Promise<void>((res) => {
    resolveNext = res;
  });
  inflight.set(chat_id, next);

  try {
    await prev;
  } catch {
    /* prior turn already surfaced its own error; we just want order */
  }

  try {
    return await fn();
  } finally {
    resolveNext();
    if (inflight.get(chat_id) === next) {
      inflight.delete(chat_id);
    }
  }
}
