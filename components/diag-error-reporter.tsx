"use client";

/**
 * Global error reporter — permanent observability (2026-06-10).
 *
 * Captures uncaught exceptions + unhandled promise rejections and ships
 * them to /api/diag/event (auth-exempt) so they land in Yen.log. The
 * webview has no visible console in release builds; without this, client
 * crashes are invisible. First catch: intent-card decide() crashing the
 * page on a 422 (cron interval) — found in minutes once this landed.
 */

import { useEffect } from "react";

export function DiagErrorReporter() {
  useEffect(() => {
    const report = (kind: string, payload: unknown) => {
      try {
        void fetch("/api/diag/event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, ...((payload as object) ?? {}) }),
        }).catch(() => {});
      } catch {
        /* never break the page from the reporter */
      }
    };

    const onError = (e: ErrorEvent) => {
      report("global-error", {
        message: e.message,
        source: `${e.filename}:${e.lineno}:${e.colno}`,
        stack: e.error instanceof Error ? e.error.stack?.slice(0, 2000) : null,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      report("unhandled-rejection", {
        message: r instanceof Error ? r.message : String(r).slice(0, 500),
        stack: r instanceof Error ? r.stack?.slice(0, 2000) : null,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
