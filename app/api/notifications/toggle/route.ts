/**
 * POST /api/notifications/toggle
 *
 * 方向 2 收尾 — flip macOS notification side-effect on/off.
 * Body: { enabled: boolean, test?: boolean }
 *
 * When `test: true`, fires a one-shot test notification immediately so
 * the user can verify the OS-level permission is granted.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { setNotifications } from "@/lib/agent/storage/trust-config";
import { sendMacosNotification } from "@/lib/agent/notifications";

export const dynamic = "force-dynamic";

async function ensureAuth(): Promise<NextResponse | null> {
  if (process.env.DEV_BYPASS_AUTH === "1") return null;
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const auth = await ensureAuth();
  if (auth) return auth;
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: unknown;
    test?: unknown;
  };
  const enabled = body.enabled === true;
  const test = body.test === true;
  const cfg = await setNotifications(enabled);

  let test_result = null;
  if (test && enabled) {
    test_result = await sendMacosNotification({
      title: "Duffy 通知測試",
      body: "你已收到一條來自 Duffy 的測試通知",
      subtitle: "可關掉了",
    });
  }

  return NextResponse.json({
    notifications_enabled: cfg.notifications_enabled ?? false,
    test_result,
  });
}
