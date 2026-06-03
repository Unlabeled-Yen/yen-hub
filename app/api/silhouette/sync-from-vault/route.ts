/**
 * POST /api/silhouette/sync-from-vault
 *
 * Reads `06 - AI Data/Silhouettes/yen.md` from the vault, parses it, and
 * writes a new Silhouette version to silhouettes.json if anything actually
 * changed. Used when Yen has hand-edited yen.md in Obsidian and wants Duffy
 * to pick up the changes.
 *
 * No intent approval — the vault edit IS Yen's explicit action.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { syncSilhouetteFromVault } from "@/lib/agent/vault-sync";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST() {
  const auth = await ensureAuth();
  if (auth) return auth;
  try {
    const result = await syncSilhouetteFromVault();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
