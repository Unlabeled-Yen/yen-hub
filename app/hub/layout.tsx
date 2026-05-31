/**
 * /hub layout — wraps all hub routes with the world clock badge.
 *
 * Any future /hub/* page automatically inherits the badge in the top-right
 * corner. Auth gating is still per-page (see /hub/page.tsx).
 */

import { WorldClock } from "@/components/world-clock";

export default function HubLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <WorldClock />
      {children}
    </>
  );
}
