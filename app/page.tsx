"use client";

/**
 * Yen — entry page (silent gate)
 *
 * Three runtime modes, selected at mount:
 *
 *   1. Dev bypass (NEXT_PUBLIC_DEV_BYPASS_AUTH=1)
 *      Watch the breathing for a moment, click or press a key → /hub.
 *      No auth call. Used during UI development.
 *
 *   2. Tauri (native macOS app)
 *      Auto-fires `invoke('authenticate')` after a 1.4s delay so the entry
 *      is dwelt on. macOS shows only the Touch ID sensor / Touch Bar prompt
 *      (no fullscreen modal). Press finger → success → /hub.
 *      Failure / cancel → silent; click or key to retry.
 *
 *   3. Browser (PWA / fallback)
 *      WebAuthn `navigator.credentials.get()` — system passkey UI appears.
 *      Same silent-gate semantics.
 *
 * First-time registration is intentionally not exposed here. Hidden at
 * /setup — see ADR 0002 §Implementation Plan.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { isTauri } from "@/lib/env/runtime";

export default function Home() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const inFlightRef = useRef(false);

  const transitionToConsole = () => {
    if (leaving) return;
    setLeaving(true);
    // NOTE: previously used document.startViewTransition() for a native
    // crossfade. Removed because in Tauri the document.visibilityState
    // becomes "hidden" while a native Touch ID prompt is open, causing
    // startViewTransition to throw InvalidStateError — which silently
    // skipped router.push and left the page stuck (then re-triggered auth
    // on the next render). Plain setTimeout+push is robust everywhere.
    setTimeout(() => router.push("/hub"), 280);
  };

  /** Browser path — WebAuthn silent gate. */
  const tryWebAuth = async () => {
    if (inFlightRef.current || leaving) return;
    inFlightRef.current = true;
    try {
      const status = await fetch("/api/auth/status").then((r) => r.json());
      if (status.authenticated) {
        transitionToConsole();
        return;
      }
      if (!status.registered || !browserSupportsWebAuthn()) return;

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
    } catch {
      // Silent.
    } finally {
      inFlightRef.current = false;
    }
  };

  /** Tauri path — native LocalAuthentication via Rust command. */
  const tryNativeAuth = async () => {
    if (inFlightRef.current || leaving) return;
    inFlightRef.current = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ok = await invoke<boolean>("authenticate", {
        reason: "welcome back",
      });
      if (!ok) return;
      // Touch ID succeeded — now mint the session cookie so /hub's
      // server-side gate lets us through.
      const confirm = await fetch("/api/auth/native-confirm", {
        method: "POST",
      });
      if (!confirm.ok) return;
      transitionToConsole();
    } catch {
      // Silent — user cancelled or biometrics unavailable.
    } finally {
      inFlightRef.current = false;
    }
  };

  useEffect(() => {
    router.prefetch("/hub");

    // Mode 1 — dev bypass
    if (process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH === "1") {
      let armed = false;
      const armT = setTimeout(() => {
        armed = true;
      }, 800);
      const enter = () => {
        if (!armed) return;
        transitionToConsole();
      };
      window.addEventListener("pointerdown", enter);
      window.addEventListener("keydown", enter);
      return () => {
        clearTimeout(armT);
        window.removeEventListener("pointerdown", enter);
        window.removeEventListener("keydown", enter);
      };
    }

    // Mode 2 — Tauri native
    if (isTauri()) {
      const initial = setTimeout(tryNativeAuth, 1400); // dwell on the breath
      const onGesture = () => tryNativeAuth();
      window.addEventListener("pointerdown", onGesture);
      window.addEventListener("keydown", onGesture);
      return () => {
        clearTimeout(initial);
        window.removeEventListener("pointerdown", onGesture);
        window.removeEventListener("keydown", onGesture);
      };
    }

    // Mode 3 — browser WebAuthn
    tryWebAuth();
    const onGesture = () => tryWebAuth();
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
      <div className="relative flex flex-col items-center">
        <div className="aura-warm" />
        <h1
          className="breathe-text-warm relative text-[96px] leading-[0.85] tracking-tight text-[var(--fg-0)] select-none"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Yen
        </h1>
        <p className="breathe-text-warm-soft relative mt-8 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-1)] uppercase select-none">
          welcome back my lovely friend
        </p>
      </div>
    </main>
  );
}
