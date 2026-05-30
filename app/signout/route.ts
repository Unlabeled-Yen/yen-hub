/**
 * GET /signout — destroys the session cookie and redirects to /.
 * Useful for testing the Touch ID flow without opening incognito.
 * Implemented as GET so you can just paste it in the URL bar.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

export async function GET(req: Request) {
  const session = await getSession();
  await session.destroy();
  const url = new URL("/", req.url);
  return NextResponse.redirect(url);
}
