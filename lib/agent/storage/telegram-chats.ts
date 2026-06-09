/**
 * Telegram chat history store.
 *
 * One entry per chat_id. Holds the rolling message history (capped) used
 * to give Duffy short-term continuity inside a Telegram conversation —
 * separate from the .app chat-palette history so Telegram's short, async
 * quips don't pollute the main thread context.
 *
 * Cap kept low (last 20 messages) so context stays cheap. If the user
 * wants persistent long-term Telegram chats, that's a future migration
 * to a richer store.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), "Library", "Application Support", "com.yen.hub");
const FILE = join(DIR, "telegram-chats.json");
const MAX_MESSAGES_PER_CHAT = 20;

export type TgChatMessage = {
  role: "user" | "assistant";
  text: string;
  ts: number;
};

type ChatMap = Record<string, TgChatMessage[]>;

let mem: ChatMap | null = null;

async function load(): Promise<ChatMap> {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(FILE, "utf8")) as ChatMap;
  } catch {
    mem = {};
  }
  return mem;
}

async function save(): Promise<void> {
  if (!mem) return;
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(mem, null, 2), "utf8");
}

export async function appendTelegramMessage(
  chat_id: number,
  msg: TgChatMessage,
): Promise<void> {
  const m = await load();
  const key = String(chat_id);
  const arr = m[key] ?? [];
  arr.push(msg);
  if (arr.length > MAX_MESSAGES_PER_CHAT) {
    arr.splice(0, arr.length - MAX_MESSAGES_PER_CHAT);
  }
  m[key] = arr;
  await save();
}

export async function readTelegramHistory(
  chat_id: number,
): Promise<TgChatMessage[]> {
  const m = await load();
  return m[String(chat_id)] ?? [];
}
