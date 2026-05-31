/**
 * Iron-session helper for App Router.
 * Provides a typed session you can read/write in route handlers and server components.
 */

import { getIronSession, type IronSession } from "iron-session";
import { cookies } from "next/headers";
import { SESSION_OPTIONS, type SessionData } from "./config";

export async function getSession(): Promise<IronSession<SessionData>> {
  const store = await cookies();
  return getIronSession<SessionData>(store, SESSION_OPTIONS);
}

export async function isAuthenticated(): Promise<boolean> {
  const s = await getSession();
  return !!s.userId;
}
