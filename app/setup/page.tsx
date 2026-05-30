"use client";

/**
 * /setup — hidden first-time registration.
 *
 * Only useful when no passkey exists yet. Once a passkey is registered,
 * visiting /setup is a no-op (the silent gate at / takes over).
 *
 * Not linked anywhere. Reach by typing /setup directly.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";

type State = "checking" | "ready" | "already-registered" | "unsupported" | "done";

export default function Setup() {
  const router = useRouter();
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    (async () => {
      if (!browserSupportsWebAuthn()) {
        setState("unsupported");
        return;
      }
      const s = await fetch("/api/auth/status").then((r) => r.json());
      if (s.registered) {
        setState("already-registered");
        setTimeout(() => router.push("/"), 1200);
        return;
      }
      setState("ready");
    })();
  }, [router]);

  const doRegister = async () => {
    try {
      const opts = await fetch("/api/auth/register/options", {
        method: "POST",
      }).then((r) => r.json());
      const att = await startRegistration({ optionsJSON: opts });
      const verify = await fetch("/api/auth/register/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(att),
      }).then((r) => r.json());
      if (verify.ok) {
        setState("done");
        setTimeout(() => router.push("/hub"), 600);
      }
    } catch {
      // ignore
    }
  };

  const label =
    state === "checking"
      ? ""
      : state === "ready"
        ? "press to register touch id"
        : state === "already-registered"
          ? "already set up"
          : state === "unsupported"
            ? "this browser does not support touch id"
            : "registered";

  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="flex flex-col items-center">
        <h1
          className="text-[120px] leading-[0.85] tracking-tight text-[var(--fg-0)] select-none"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Yen
        </h1>
        <button
          type="button"
          onClick={state === "ready" ? doRegister : undefined}
          disabled={state !== "ready"}
          className="mt-20 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase select-none disabled:cursor-default hover:enabled:text-[var(--fg-0)] transition-colors"
        >
          {label}
        </button>
      </div>
    </main>
  );
}
