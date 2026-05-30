"use client";

/**
 * Yen — entry page (silent gate)
 *
 * On load:
 *   - Fire WebAuthn auth silently.
 *   - macOS shows its own Touch ID prompt — we don't add any UI for it.
 *   - Success → fade → /hub.
 *   - Failure / cancel → nothing visible happens. Click anywhere to retry silently.
 *
 * First-time registration is intentionally not exposed here. If no passkey
 * exists, the user is stuck at this page — by design. Go to /setup to register.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";

export default function Home() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const inFlightRef = useRef(false);

  const transitionToConsole = () => {
    if (leaving) return;
    setLeaving(true);
    // Push BEFORE the fade-out finishes so /hub's flip-in starts while the
    // entry is still ~half-visible — they overlap visually.
    // Entry transition-opacity is 700ms; we push at 280ms (≈ 60% opacity left).
    if (typeof document !== "undefined" && "startViewTransition" in document) {
      // Native crossfade where supported (Chrome / Edge / Safari 18+)
      (document as Document & { startViewTransition: (cb: () => void) => void })
        .startViewTransition(() => router.push("/hub"));
    } else {
      setTimeout(() => router.push("/hub"), 280);
    }
  };

  const tryAuth = async () => {
    if (inFlightRef.current || leaving) return;
    inFlightRef.current = true;
    try {
      // If we already have a valid session, skip straight to console.
      const status = await fetch("/api/auth/status").then((r) => r.json());
      if (status.authenticated) {
        transitionToConsole();
        return;
      }
      if (!status.registered || !browserSupportsWebAuthn()) {
        // Silent dead-end. Nothing to do.
        return;
      }

      const opts = await fetch("/api/auth/authenticate/options", {
        method: "POST",
      }).then((r) => r.json());

      const assertResp = await startAuthentication({ optionsJSON: opts });

      const verifyData = await fetch("/api/auth/authenticate/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assertResp),
      }).then((r) => r.json());

      if (verifyData.ok) transitionToConsole();
      // else: stay silent on failure.
    } catch {
      // Swallow — silent gate.
    } finally {
      inFlightRef.current = false;
    }
  };

  useEffect(() => {
    // Warm /hub bundle so it's ready the moment we navigate.
    router.prefetch("/hub");

    // Dev bypass — skip Touch ID and go straight in. Disable via env.
    if (process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "1") {
      transitionToConsole();
      return;
    }
    // Auto-fire on load.
    tryAuth();

    // Any user gesture silently retries.
    const onGesture = () => tryAuth();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main
      className={`flex flex-1 items-center justify-center px-6 transition-opacity duration-700 ease-out ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Single relative wrapper around both lines, with one shared aura
          centered slightly below YEN. Text stays at full opacity — only
          the light around it breathes. */}
      <div className="relative flex flex-col items-center">
        <div className="aura-warm" />
        <h1
          className="breathe-text-warm relative text-[120px] leading-[0.85] tracking-tight text-[var(--fg-0)] select-none"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Yen
        </h1>
        <p className="breathe-text-warm-soft relative mt-16 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-1)] uppercase select-none">
          welcome back my lovely friend
        </p>
      </div>
    </main>
  );
}
