/**
 * POST   /api/vault/todos/priority  → promote a TODO to 首要代辦
 * DELETE /api/vault/todos/priority  → demote
 *
 * Body: { file: string, lineNum: number, text: string }
 *
 * Priority is a user-curated overlay separate from done. Items still
 * appear in the Overview tab; they additionally surface in the Priority
 * tab when marked. Strike-through (done) and priority are independent.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { markPriority, unmarkPriority } from "@/lib/vault/priority-store";
import {
  addPriorityTagToVault,
  removePriorityTagFromVault,
} from "@/lib/vault/priority-write";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

type Body = { file?: unknown; lineNum?: unknown; text?: unknown };

function parseBody(b: Body): { file: string; lineNum: number; text: string } | null {
  if (
    typeof b?.file !== "string" ||
    typeof b?.text !== "string" ||
    typeof b?.lineNum !== "number"
  ) {
    return null;
  }
  return { file: b.file, lineNum: b.lineNum, text: b.text };
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = parseBody(await req.json().catch(() => ({})));
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  // Dual-write: overlay (fast, drives UI) + vault tag (real, drives Obsidian).
  // Vault write happens in parallel; if it fails the overlay still wins so
  // the UI doesn't flicker, but the failure is reported in the response so
  // callers can log it.
  const [, vault] = await Promise.all([
    markPriority(body.file, body.lineNum, body.text),
    addPriorityTagToVault(body.file, body.text),
  ]);
  return NextResponse.json({ ok: true, vault });
}

export async function DELETE(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = parseBody(await req.json().catch(() => ({})));
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const [, vault] = await Promise.all([
    unmarkPriority(body.file, body.text),
    removePriorityTagFromVault(body.file, body.text),
  ]);
  return NextResponse.json({ ok: true, vault });
}
