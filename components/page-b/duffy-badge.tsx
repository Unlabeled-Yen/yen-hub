"use client";

/**
 * DuffyBadge — sits on Page A as Yen's gateway to Duffy's space (Page B).
 *
 * Four visual states (in priority order):
 *   1. **Active**     — 1+ unread HIGH observations: orange chip with count
 *   2. **Thinking**   — Duffy currently streaming in command-palette
 *                       (palette may be closed): breathing dot, "Duffy 正在想"
 *   3. **Fresh reply** — Duffy finished a stream while palette was closed:
 *                       steady amber glow, "Duffy 回應好了"
 *   4. **Quiet**      — none of the above: subtle "→ Duffy" link
 *
 * Polls /api/observations/unread-high every 30s for state 1.
 * Listens to window CustomEvent "yen-duffy-status" (dispatched by
 * command-palette) for states 2/3. See command-palette.tsx Slice 8.6 hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";

const POLL_MS = 30_000;

type Top = { id: string; title: string; created_at: number };

type DuffyChatStatus = "idle" | "thinking" | "fresh-reply";

export function DuffyBadge() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [top, setTop] = useState<Top[]>([]);
  const [chatStatus, setChatStatus] = useState<DuffyChatStatus>("idle");
  const prevStatusRef = useRef<string>("ready");

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/observations/unread-high");
      if (!res.ok) return;
      const data = (await res.json()) as { count: number; top: Top[] };
      setCount(data.count);
      setTop(data.top);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Listen to command-palette's status broadcasts.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        status: string;
        paletteOpen: boolean;
      };
      const newStatus = detail.status;
      const paletteOpen = detail.paletteOpen;

      // Opening the palette clears fresh-reply (Yen is reading now).
      if (paletteOpen) {
        setChatStatus(newStatus === "submitted" || newStatus === "streaming"
          ? "thinking"
          : "idle");
        prevStatusRef.current = newStatus;
        return;
      }

      // Palette closed → derive badge state from useChat status.
      if (newStatus === "submitted" || newStatus === "streaming") {
        setChatStatus("thinking");
      } else if (
        (prevStatusRef.current === "streaming" ||
          prevStatusRef.current === "submitted") &&
        newStatus === "ready"
      ) {
        // Just finished streaming while palette is closed → fresh reply waits.
        setChatStatus("fresh-reply");
      }
      // Otherwise leave existing state (don't clobber fresh-reply with idle).
      prevStatusRef.current = newStatus;
    };
    window.addEventListener("yen-duffy-status", handler);
    return () => window.removeEventListener("yen-duffy-status", handler);
  }, []);

  const active = count > 0;
  const thinking = chatStatus === "thinking";
  const fresh = chatStatus === "fresh-reply";

  // Priority: unread HIGH wins; otherwise chat status; otherwise quiet.
  let mode: "active" | "thinking" | "fresh" | "quiet";
  if (active) mode = "active";
  else if (thinking) mode = "thinking";
  else if (fresh) mode = "fresh";
  else mode = "quiet";

  const styles = (() => {
    switch (mode) {
      case "active":
        return {
          background: "rgba(255,181,71,0.10)",
          border: "1px solid var(--warn)",
          color: "var(--warn)",
        };
      case "thinking":
        return {
          background: "rgba(var(--palette-accent-rgb),0.06)",
          border: "1px solid rgba(var(--palette-accent-rgb),0.45)",
          color: "var(--palette-accent)",
        };
      case "fresh":
        return {
          background: "rgba(var(--palette-accent-rgb),0.14)",
          border: "1px solid var(--palette-accent)",
          color: "var(--palette-accent)",
        };
      case "quiet":
      default:
        return {
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.10)",
          color: "var(--fg-2)",
        };
    }
  })();

  const label = (() => {
    switch (mode) {
      case "active":
        return `Duffy 想跟你說 · ${count}`;
      case "thinking":
        return "Duffy 正在想⋯";
      case "fresh":
        return "Duffy 回應好了";
      case "quiet":
      default:
        return "→ Duffy";
    }
  })();

  const title = (() => {
    switch (mode) {
      case "active":
        return top.map((t) => `· ${t.title}`).join("\n");
      case "thinking":
        return "Duffy 正在打字（你關掉對話框、他還在跑）";
      case "fresh":
        return "Duffy 上一條對話的回應已完成，點進去看";
      default:
        return "進入 Duffy 空間";
    }
  })();

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-auto"
    >
      <Link
        href="/hub/page-b"
        title={title}
        onClick={(e) => {
          e.preventDefault();
          // Diag + multiple navigation attempts. Verified previously:
          //   - Link default click → did NOT navigate
          //   - router.push() → did NOT navigate
          // Try router.push (logs error if throws), then fall through to
          // window.location.href as the unbeatable last resort. Native
          // browser navigation does not rely on React/Next.js routing.
          let pushErr: string | null = null;
          try {
            router.push("/hub/page-b");
          } catch (e) {
            pushErr = e instanceof Error ? e.message : String(e);
          }
          void fetch("/api/diag/event", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "duffybadge.click",
              t: new Date().toISOString().slice(11, 23),
              mode,
              pushErr,
            }),
            keepalive: true,
          }).catch(() => {});
          // Fallback after a tick — if router.push hasn't navigated by
          // then, force native nav. (Cancelled implicitly if router.push
          // succeeded since the page will have unmounted.)
          setTimeout(() => {
            if (window.location.pathname !== "/hub/page-b") {
              window.location.href = "/hub/page-b";
            }
          }, 100);
        }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors"
        style={styles}
      >
        {/* Status dot:
            - active (HIGH unread): warm warn glow
            - thinking: mint dot that breathes (opacity 0.4 → 1 → 0.4)
            - fresh:    steady mint dot with strong glow
            - quiet:    no dot */}
        {mode === "active" && (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: "var(--warn)",
              boxShadow: "0 0 8px var(--warn)",
            }}
          />
        )}
        {mode === "thinking" && (
          <motion.span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: "var(--palette-accent)",
              boxShadow: "0 0 6px var(--palette-accent)",
            }}
            animate={{ opacity: [0.4, 1, 0.4], scale: [0.85, 1.05, 0.85] }}
            transition={{
              duration: 1.2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        )}
        {mode === "fresh" && (
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: "var(--palette-accent)",
              boxShadow: "0 0 10px var(--palette-accent), 0 0 18px rgba(var(--palette-accent-rgb),0.4)",
            }}
          />
        )}
        <span className="text-[10px] font-mono tracking-[0.24em] uppercase">
          {label}
        </span>
      </Link>
    </motion.div>
  );
}
