/**
 * POST /api/intents/[id]/decide
 *
 * Body: { decision: "approve" | "reject" }
 *
 * Kind-aware dispatch: on approve, the intent's `kind` decides which store
 * to materialise into:
 *   - "observation"        → observations.json (createObservationFromIntent)
 *   - "silhouette_update"  → silhouettes.json (createSilhouetteFromIntent)
 *   - "summary"            → summaries.json   (createSummaryFromIntent)
 *
 * After materialisation, vault-bridge writes a Markdown mirror under
 * `06 - AI Data/{Observations,Silhouettes,Summaries}/` (Slice 7A Step 2;
 * placeholder import for now, will land in next commit).
 *
 * Idempotent: deciding an already-decided intent returns the existing record
 * without re-running side effects.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { decideIntent, getIntent } from "@/lib/agent/storage/intents";
import {
  createObservationFromIntent,
  touchIntention,
} from "@/lib/agent/storage/observations";
import { createSilhouetteFromIntent } from "@/lib/agent/storage/silhouettes";
import { createSummaryFromIntent } from "@/lib/agent/storage/summaries";
import {
  isObservationPayload,
  isSilhouetteUpdatePayload,
  isSummaryPayload,
  isFileCreatePayload,
  isFileEditPayload,
  isTodoPlanPayload,
} from "@/lib/agent/storage/types";
import { promises as fs } from "node:fs";
import { resolve, sep, dirname } from "node:path";
import { vaultPath } from "@/lib/vault/reader";
import {
  writeObservationToVault,
  writeSilhouetteToVault,
  writeSummaryToVault,
} from "@/lib/agent/vault-bridge";
import { bustCoachCache } from "@/lib/agent/duffy/coach";

export const dynamic = "force-dynamic";

async function ensureAuth() {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

type Body = { decision?: unknown };

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as Body;
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: "decision must be 'approve' or 'reject'" },
      { status: 400 },
    );
  }

  const existing = await getIntent(id);
  if (!existing) {
    return NextResponse.json({ error: "intent not found" }, { status: 404 });
  }

  // Already decided — return current state, don't double-write.
  if (existing.status !== "pending") {
    return NextResponse.json({ intent: existing, materialised: null });
  }

  // Reject path — just flip the status, no side effects.
  if (decision === "reject") {
    const updated = await decideIntent(id, "rejected");
    return NextResponse.json({ intent: updated, materialised: null });
  }

  // Approve path — dispatch by kind.
  let resulted_in: string | undefined;
  let materialised: unknown = null;

  if (isObservationPayload(existing)) {
    const obs = await createObservationFromIntent({
      intent_id: existing.id,
      title: existing.payload.title,
      body: existing.payload.body,
      zone: existing.payload.zone,
      window: existing.payload.window,
      evidence: existing.evidence,
      source_agent_id: existing.proposed_by,
      reason: existing.rationale,
      importance: existing.importance,
      intention: existing.payload.intention,   // Slice 8
      nudge_for: existing.payload.nudge_for,   // Slice 8
    });
    resulted_in = obs.id;
    materialised = { kind: "observation", record: obs };
    // Approving a nudge bumps the source intention's last_touched_at so
    // it leaves the stale cohort for another N days. Yen acknowledged
    // it; cron shouldn't re-nudge immediately.
    if (existing.payload.nudge_for) {
      await touchIntention(existing.payload.nudge_for);
    }
    await writeObservationToVault(obs);
  } else if (isSilhouetteUpdatePayload(existing)) {
    const sil = await createSilhouetteFromIntent({
      intent_id: existing.id,
      source_agent_id: existing.proposed_by,
      reason: existing.rationale,
      payload: existing.payload,
    });
    resulted_in = sil.id;
    materialised = { kind: "silhouette", record: sil };
    await writeSilhouetteToVault(sil);
  } else if (isSummaryPayload(existing)) {
    const sum = await createSummaryFromIntent({
      intent_id: existing.id,
      source_agent_id: existing.proposed_by,
      payload: existing.payload,
    });
    resulted_in = sum.id;
    materialised = { kind: "summary", record: sum };
    await writeSummaryToVault(sum);
  } else if (isFileCreatePayload(existing)) {
    // Slice 9 L2 — create a new vault file.
    const root = vaultPath();
    const abs = resolve(root, existing.payload.path);
    if (!(abs === root || abs.startsWith(root + sep))) {
      return NextResponse.json(
        { error: "path escapes vault", payload_path: existing.payload.path },
        { status: 400 },
      );
    }
    try {
      await fs.access(abs);
      return NextResponse.json(
        { error: "file already exists; refusing to overwrite", path: existing.payload.path },
        { status: 409 },
      );
    } catch {
      /* file doesn't exist — good, proceed */
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    // Atomic write: tmp + rename.
    const tmp = abs + ".tmp-" + Date.now();
    await fs.writeFile(tmp, existing.payload.content, "utf8");
    await fs.rename(tmp, abs);
    materialised = { kind: "file_create", path: existing.payload.path };
  } else if (isFileEditPayload(existing)) {
    // Slice 9 L2 — edit existing vault file.
    const root = vaultPath();
    const abs = resolve(root, existing.payload.path);
    if (!(abs === root || abs.startsWith(root + sep))) {
      return NextResponse.json(
        { error: "path escapes vault" },
        { status: 400 },
      );
    }
    let original: string;
    try {
      original = await fs.readFile(abs, "utf8");
    } catch (e) {
      return NextResponse.json(
        { error: `cannot read file: ${e instanceof Error ? e.message : String(e)}` },
        { status: 404 },
      );
    }
    // old_text must appear EXACTLY ONCE — otherwise the edit is ambiguous.
    const firstIdx = original.indexOf(existing.payload.old_text);
    const lastIdx = original.lastIndexOf(existing.payload.old_text);
    if (firstIdx === -1) {
      return NextResponse.json(
        { error: "old_text not found in file" },
        { status: 422 },
      );
    }
    if (firstIdx !== lastIdx) {
      return NextResponse.json(
        { error: "old_text appears multiple times; ambiguous edit refused" },
        { status: 422 },
      );
    }
    const updated =
      original.slice(0, firstIdx) +
      existing.payload.new_text +
      original.slice(firstIdx + existing.payload.old_text.length);
    // Backup + atomic write.
    await fs.writeFile(abs + ".bak", original, "utf8");
    const tmp = abs + ".tmp-" + Date.now();
    await fs.writeFile(tmp, updated, "utf8");
    await fs.rename(tmp, abs);
    materialised = { kind: "file_edit", path: existing.payload.path };
  } else if (isTodoPlanPayload(existing)) {
    // Slice 9 L2 — append todo plan to Duffy Todo Inbox.
    const root = vaultPath();
    const inboxRel = "05 - Queue/Duffy Todo Inbox.md";
    const abs = resolve(root, inboxRel);
    if (!(abs === root || abs.startsWith(root + sep))) {
      return NextResponse.json(
        { error: "path escapes vault" },
        { status: 400 },
      );
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    const stamp = new Date().toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const header = `\n\n## ${existing.payload.title}  · ${stamp}\n`;
    const lines = existing.payload.items
      .map((it) => `- [ ] ${it.text}${it.category ? ` _(${it.category})_` : ""}`)
      .join("\n");
    let prior = "";
    try {
      prior = await fs.readFile(abs, "utf8");
    } catch {
      prior = "# Duffy Todo Inbox\n\n_由 Duffy propose、Yen approve 後寫入。_\n";
    }
    await fs.writeFile(abs, prior + header + lines + "\n", "utf8");
    materialised = { kind: "todo_plan", path: inboxRel, count: existing.payload.items.length };
  }

  const updated = await decideIntent(id, "approved", resulted_in);
  // Any approval invalidates the coach card so the next /api/coach pulls
  // a fresh read that reflects the new state.
  bustCoachCache();
  return NextResponse.json({ intent: updated, materialised });
}
