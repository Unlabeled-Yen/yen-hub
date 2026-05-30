/**
 * /hub — the overview.
 *
 * Single dense page with module tiles. All 8 pillars visible at once.
 * Per ADR 0002 — no tab navigation. The command palette handles conversation
 * and (eventually) module drill-in.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Overview } from "./overview";

export default async function Hub() {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) redirect("/");
  }
  return <Overview />;
}
