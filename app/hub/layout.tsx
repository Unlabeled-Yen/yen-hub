/**
 * /hub layout — currently a passthrough. WorldClock used to be mounted
 * here as a viewport-fixed badge but was moved INTO MarketMonitor so it
 * scrolls with the US30 panel and sits right above the hover-time row.
 */

export default function HubLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
