"use client";

/**
 * Top nav — thin bar that teases the larger hub structure.
 * 4 main areas: Console / Pipelines / Mirror / Vault.
 * Optional "+ new" slot on the right for context-specific actions.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/console", label: "console" },
  { href: "/pipelines", label: "pipelines" },
  { href: "/mirror", label: "mirror" },
  { href: "/vault", label: "vault" },
];

export function TopNav({ right }: { right?: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-0)]/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 sm:px-12 h-10">
        <nav className="flex items-center gap-6">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative text-[10px] font-mono tracking-[0.32em] uppercase transition-colors ${
                  active ? "text-[var(--fg-0)]" : "text-[var(--fg-2)] hover:text-[var(--fg-1)]"
                }`}
              >
                {item.label}
                {active && (
                  <span className="absolute -bottom-[15px] left-0 right-0 h-px bg-[var(--fg-0)]" />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3">{right}</div>
      </div>
    </div>
  );
}
