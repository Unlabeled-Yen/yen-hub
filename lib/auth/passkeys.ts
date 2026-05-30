/**
 * Passkey storage — JSON file for v0.
 * Will migrate to Turso/SQLite when we add other persistent state.
 *
 * One file = one record per credentialID.
 * For Yen Hub (single user) this is plenty.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const STORE_PATH = process.env.PASSKEY_STORE ?? "./data/passkeys.json";

export type StoredPasskey = {
  credentialID: string;          // base64url
  publicKey: string;             // base64url of Uint8Array
  counter: number;
  transports?: string[];
  createdAt: number;
  label?: string;                // e.g. "MacBook Pro Touch ID"
};

export type PasskeyStore = {
  passkeys: StoredPasskey[];
  // Most recent challenge issued — single-user, so we don't need per-user maps.
  currentChallenge?: string;
};

async function readStore(): Promise<PasskeyStore> {
  try {
    const txt = await fs.readFile(STORE_PATH, "utf8");
    return JSON.parse(txt) as PasskeyStore;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { passkeys: [] };
    }
    throw e;
  }
}

async function writeStore(store: PasskeyStore): Promise<void> {
  await fs.mkdir(dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function hasAnyPasskey(): Promise<boolean> {
  const s = await readStore();
  return s.passkeys.length > 0;
}

export async function listPasskeys(): Promise<StoredPasskey[]> {
  const s = await readStore();
  return s.passkeys;
}

export async function findPasskey(credentialID: string): Promise<StoredPasskey | undefined> {
  const s = await readStore();
  return s.passkeys.find((p) => p.credentialID === credentialID);
}

export async function addPasskey(pk: StoredPasskey): Promise<void> {
  const s = await readStore();
  s.passkeys.push(pk);
  await writeStore(s);
}

export async function updatePasskeyCounter(credentialID: string, counter: number): Promise<void> {
  const s = await readStore();
  const pk = s.passkeys.find((p) => p.credentialID === credentialID);
  if (pk) {
    pk.counter = counter;
    await writeStore(s);
  }
}

export async function setChallenge(challenge: string): Promise<void> {
  const s = await readStore();
  s.currentChallenge = challenge;
  await writeStore(s);
}

export async function consumeChallenge(): Promise<string | undefined> {
  const s = await readStore();
  const c = s.currentChallenge;
  s.currentChallenge = undefined;
  await writeStore(s);
  return c;
}
