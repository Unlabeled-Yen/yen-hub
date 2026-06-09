"use client";

/**
 * Global error boundary — replaces Next 16's default "This page couldn't
 * load" page. Two jobs:
 *
 *   1. Ship the error (message + stack + digest) to /api/diag/event so
 *      production crashes are observable in Yen.log (webview has no
 *      visible console).
 *   2. Render a minimal dark fallback with a reload button, styled to
 *      not look like a browser error page.
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      void fetch("/api/diag/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "global-error-boundary",
          message: error.message?.slice(0, 500),
          digest: error.digest ?? null,
          stack: error.stack?.slice(0, 2000) ?? null,
        }),
      }).catch(() => {});
    } catch {
      /* reporter must never throw */
    }
  }, [error]);

  return (
    <html lang="zh-Hant">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#ededed",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <div style={{ fontSize: 14, opacity: 0.9, marginBottom: 8 }}>
            畫面出了一點狀況
          </div>
          <div
            style={{
              fontSize: 11,
              opacity: 0.5,
              marginBottom: 20,
              fontFamily: "monospace",
              wordBreak: "break-all",
            }}
          >
            {error.message?.slice(0, 200) ?? "unknown"}
            {error.digest ? ` · ${error.digest}` : ""}
          </div>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.06)",
              color: "#ededed",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            回復
          </button>
        </div>
      </body>
    </html>
  );
}
