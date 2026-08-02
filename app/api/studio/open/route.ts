/**
 * POST /api/studio/open — the door-knob endpoint.
 *
 * Uses macOS `open` to hand a whitelisted path to the OS (project → Finder /
 * associated app; checkpoint .md → default markdown editor, typically
 * Obsidian). The whitelist lives in lib/studio/state.ts — nothing here trusts
 * caller input for paths.
 *
 * execFile (not exec) + argv array → no shell interpolation possible.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { resolveTarget } from "@/lib/studio/state";

const run = promisify(execFile);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  let body: { project?: string; kind?: string };
  try {
    body = (await req.json()) as { project?: string; kind?: string };
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const project = body.project ?? "";
  const kind = body.kind === "checkpoint" ? "checkpoint" : "project";
  const target = resolveTarget(project, kind);
  if (!target) {
    return NextResponse.json(
      { error: `unknown target: ${project}/${kind}` },
      { status: 400 },
    );
  }
  try {
    await run("open", [target], { timeout: 5000 });
    return NextResponse.json({ ok: true, opened: target });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
