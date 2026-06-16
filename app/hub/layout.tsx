/**
 * /hub layout — persistent shell: [Sidebar | content].
 *
 * The sidebar (components/hub/sidebar.tsx) is a client component; this layout
 * stays a server component so it doesn't force the whole subtree client.
 *
 * CommandPalette is mounted HERE (lifted out of overview.tsx) so the
 * spacebar-summon works on every /hub screen — dashboard, page-b, and the
 * conversation pages — not just the home page. It portals to <body> and uses a
 * global keydown listener, so it has no coupling to whatever route renders
 * behind it.
 *
 * The content wrapper MUST keep `min-w-0` — otherwise the flex child won't
 * shrink below its content width and the overview carousel's measured-width
 * math (and the sidebar-collapse re-expand) breaks.
 */

import { CommandPalette } from "@/components/command-palette";
import { DiagErrorReporter } from "@/components/diag-error-reporter";
import { Sidebar } from "@/components/hub/sidebar";

export default function HubLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-row">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <CommandPalette />
      <DiagErrorReporter />
    </div>
  );
}
