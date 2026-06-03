"use client";

/**
 * MarkHighReadOnMount — fires POST /api/observations/mark-high-read once
 * when Page B mounts. v1 semantics: entering Page B = "I've seen everything
 * Duffy has been trying to tell me", so the Page A badge clears.
 *
 * Per-observation read marking can come later if Yen wants finer control.
 */

import { useEffect, useRef } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

export function MarkHighReadOnMount() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void tokenFetch("/api/observations/mark-high-read", { method: "POST" });
  }, []);
  return null;
}
