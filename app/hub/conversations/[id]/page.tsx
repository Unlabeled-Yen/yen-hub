/**
 * /hub/conversations/[id] — full read-only view of one conversation thread.
 *
 * Server component: auth gate only. The thread is rendered by the client child
 * <ConversationView /> (it reads the client-only store / [id] API).
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ConversationView } from "@/components/chat/conversation-view";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) redirect("/");
  }
  const { id } = await params;
  return <ConversationView id={id} />;
}
