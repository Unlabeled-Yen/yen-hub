/**
 * /hub/conversations — 對話紀錄管理 landing.
 *
 * Server component: auth gate only (same pattern as app/hub/page.tsx). The
 * actual list reads the client-only conversation store, so it lives in the
 * client child <ConversationsList />.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ConversationsList } from "@/components/chat/conversations-list";

export const dynamic = "force-dynamic";

export default async function ConversationsPage() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) redirect("/");
  }
  return <ConversationsList />;
}
