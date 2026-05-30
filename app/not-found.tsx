"use client";

/**
 * Custom 404 — themed cream + auto-redirect home.
 * Anything not matching a known route bounces back to /.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NotFound() {
  const router = useRouter();

  useEffect(() => {
    const t = setTimeout(() => router.replace("/"), 1200);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="flex flex-col items-center">
        <h1
          className="text-[140px] leading-[0.85] tracking-tight text-[var(--fg-0)] select-none"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Yen
        </h1>
        <p className="mt-10 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase">
          taking you home
        </p>
      </div>
    </main>
  );
}
