/**
 * Iron-session helper for App Router.
 * Provides a typed session you can read/write in route handlers and server components.
 */

import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { SESSION_OPTIONS, type SessionData } from "./config";

export async function getSession(): Promise<
  SessionData & {
    save: () => Promise<void>;
    destroy: () => Promise<void>;
  }
> {
  const store = await cookies();
  // iron-session expects a CookieStore-shaped object
  const session = await getIronSession<SessionData>(store, SESSION_OPTIONS);
  return session;
}

export async function isAuthenticated(): Promise<boolean> {
  const s = await getSession();
  return !!s.userId;
}
