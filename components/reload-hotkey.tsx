"use client";

/**
 * Global keyboard shortcuts Tauri webview doesn't ship by default:
 *
 *   ⌘R     → navigate to "/" (entry page) — keeps session
 *   ⌘⇧L    → clear session AND go to entry (real lock)
 */

import { useEffect } from "react";

export function ReloadHotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();

      // ⌘R — go to entry (front page)
      if (k === "r" && !e.shiftKey) {
        e.preventDefault();
        window.location.href = "/";
        return;
      }
      // ⌘⇧L — lock: clear session cookie, then route hits entry
      if (k === "l" && e.shiftKey) {
        e.preventDefault();
        window.location.href = "/signout";
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
