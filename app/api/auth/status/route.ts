import { NextResponse } from "next/server";
import { hasAnyPasskey } from "@/lib/auth/passkeys";
import { isAuthenticated } from "@/lib/auth/session";

export async function GET() {
  return NextResponse.json({
    registered: await hasAnyPasskey(),
    authenticated: await isAuthenticated(),
  });
}
