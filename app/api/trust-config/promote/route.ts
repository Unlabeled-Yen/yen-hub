/**
 * POST /api/trust-config/promote
 *
 * Slice 12 Phase 3 — accept a tier suggestion from the banner.
 * Body: { kind: IntentKind, tier: "L0" | "L1" | "L2" | null }
 *
 * null tier removes the override and reverts to defaultTrustTier(kind).
 *
 * No risk gating here — banner-level UI already shows the user the rate
 * and asks for confirmation; this endpoint just persists the decision.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  setKindOverride,
  setZoneOverride,
} from "@/lib/agent/storage/trust-config";
import { trustBucketKey } from "@/lib/agent/storage/trust-zones";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

const VALID_KINDS = new Set([
  "observation",
  "silhouette_update",
  "summary",
  "file_create",
  "file_edit",
  "todo_plan",
  "schedule_create",
  "schedule_cancel",
]);

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;

  const body = (await req.json().catch(() => ({}))) as {
    kind?: unknown;
    tier?: unknown;
  };

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!VALID_KINDS.has(kind)) {
    return NextResponse.json(
      { error: "invalid kind" },
      { status: 400 },
    );
  }

  const tier = body.tier;
  if (tier !== null && tier !== "L0" && tier !== "L1" && tier !== "L2") {
    return NextResponse.json(
      { error: "tier must be 'L0' | 'L1' | 'L2' | null" },
      { status: 400 },
    );
  }

  // Path-bearing kinds (file_create / file_edit) are governed PER ZONE since
  // Phase 4b — the workspace is already L0 statically, so an explicit manual
  // "trust this kind" applies to the gated main-vault zone. Persist the
  // functional override there; also mirror to kind_overrides so the banner's
  // "already promoted" check + the UI reflect the decision (the kind-level
  // value is display-only for path kinds — tierForIntent ignores it).
  const isPathKind = kind === "file_create" || kind === "file_edit";
  if (isPathKind) {
    await setZoneOverride(trustBucketKey(kind, "vault"), tier);
  }
  const updated = await setKindOverride(kind, tier);
  return NextResponse.json({
    kind,
    tier,
    kind_overrides: updated.kind_overrides ?? {},
    zone_overrides: updated.zone_overrides ?? {},
  });
}
