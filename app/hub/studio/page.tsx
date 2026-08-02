/**
 * /hub/studio — the studio face fed by REAL cross-project work-state
 * (git + checkpoint memory) instead of vault mirrors.
 *
 * Additive: a new route that does not touch the existing overview/panels.
 * Inherits the /hub shell (sidebar + command palette) from app/hub/layout.tsx.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { StudioView } from "@/components/studio/studio-view";

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) redirect("/");
  }
  return <StudioView />;
}
