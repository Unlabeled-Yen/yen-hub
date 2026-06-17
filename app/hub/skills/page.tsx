/**
 * /hub/skills — Skill 管理中心. Server component: auth gate only; the list +
 * editor live in the client <SkillCenter />.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { SkillCenter } from "@/components/skills/skill-center";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) redirect("/");
  }
  return <SkillCenter />;
}
