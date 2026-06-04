"use client";

/**
 * CommandPalette — immersive, no card.
 *
 * Layout:
 *   - Initially just a single thin command line floating around 60% from
 *     the top — no box, no border, no card.
 *   - As messages arrive, they stack ABOVE the line. The line stays put;
 *     the conversation grows upward.
 *   - The hub overview behind stays visible (no backdrop blur).
 *
 * Summoning:
 *   - Any printable key (alphanum, punctuation) opens the palette.
 *   - For Latin keys: opens + prefills with that key.
 *   - For IME composition (Chinese / Japanese etc): opens + immediately
 *     focuses the textarea, NO prefill — the active composition continues
 *     into the textarea so the user's first character isn't lost.
 *   - ⌘K opens empty
 *   - Esc closes
 *   - Click outside the input/messages closes
 */

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { motion, useMotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IntentCard } from "@/components/agent/intent-card";
import {
  getSidecarToken,
  sidecarHeaders,
} from "@/lib/security/sidecar-token";
import {
  createConversation,
  deriveTitle,
  ensureActive,
  loadFromServer,
  saveConversation,
  type Conversation as Convo,
} from "@/lib/conversations/store";

/** Sentinel format Duffy embeds in chat to surface an approval card inline.
 *  See `lib/agent/duffy/prompt.ts` and `lib/agent/duffy/agent.ts`. */
const INTENT_SENTINEL = /<<INTENT:(int_[A-Za-z0-9-]+)>>/g;

/** Sentinel Duffy embeds when Yen asks to start a fresh conversation. The
 *  client rolls a new conversation after the current turn finishes
 *  rendering. */
const NEW_CONVERSATION_SENTINEL = /<<NEW_CONVERSATION>>/;

/** Sentinel the CLIENT sends as a user message right after a fresh
 *  conversation animation completes. Duffy's prompt has a rule that, when
 *  this is the only user text, he replies with a short greeting. The Turn
 *  renderer hides this synthetic user message so visually it looks like
 *  Duffy spontaneously says hello. */
const GREET_INIT_SENTINEL = "__DUFFY_GREET_INIT__";

/** Choreography phases for the new-conversation animation. */
type NewConvoPhase =
  | "idle"
  | "shrinking-messages" // chat history slides down + collapses
  | "iris-close"         // command line shrinks horizontally toward centre
  | "iris-open"          // command line expands back out
  | "breathing";         // brief settled pause before Duffy auto-greets

/** Slice 7.7 — fetch the latest server-side inflight response for this
 *  conversation and merge it in if it represents work Yen hasn't seen yet.
 *  Handles three cases:
 *    - no inflight                       → no-op
 *    - inflight.text already in messages → no-op (already merged)
 *    - inflight.text NOT in messages     → append as assistant turn
 *  Status 'done' / 'error' entries are cleared after consumption; 'streaming'
 *  entries are left untouched so a later poll can pick up more text.        */
async function reconcileInflight(
  convoId: string,
  current: UIMessage[],
  apply: (next: UIMessage[]) => void,
): Promise<void> {
  try {
    const headers: Record<string, string> = sidecarHeaders();
    const res = await fetch(
      `/api/chat/inflight?conversation=${encodeURIComponent(convoId)}`,
      { headers },
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      inflight: {
        turnId: string;
        text: string;
        status: "streaming" | "done" | "error";
        error?: string;
      } | null;
    };
    const inflight = data.inflight;
    if (!inflight || !inflight.text) return;

    // Already merged? Compare against last assistant message.
    const lastAssistant = [...current]
      .reverse()
      .find((m) => m.role === "assistant");
    const lastAssistantText = lastAssistant
      ? (lastAssistant.parts ?? [])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("")
      : "";
    if (lastAssistantText && lastAssistantText.includes(inflight.text)) {
      // Server text is a subset of what client already has — nothing new.
      // Still clear on done/error so subsequent reopens don't churn.
      if (inflight.status !== "streaming") {
        void fetch(
          `/api/chat/inflight?conversation=${encodeURIComponent(convoId)}`,
          { method: "DELETE", headers },
        );
      }
      return;
    }

    // Append (or replace tail) — simplest correct behaviour: add a new
    // assistant message with the full server text.
    const newAssistant: UIMessage = {
      id: inflight.turnId,
      role: "assistant",
      parts: [{ type: "text", text: inflight.text }],
    } as UIMessage;
    apply([...current, newAssistant]);

    if (inflight.status !== "streaming") {
      void fetch(
        `/api/chat/inflight?conversation=${encodeURIComponent(convoId)}`,
        { method: "DELETE", headers },
      );
    }
  } catch {
    /* silent — inflight reconciliation is best-effort */
  }
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

/** Single-stage inactivity timeout before the palette starts fading.
 *  Per Yen — removed the previous "3s → collapse to peek → 5s → close"
 *  two-stage flow. Now: stays fully expanded the whole time, just auto-
 *  dismisses after a longer 1-minute idle. */
const INACTIVITY_CLOSE_MS = 60_000;

/** Fade-out duration before the palette unmounts. */
const FADE_MS = 1000;

// sessionStorage key for preserving unsent draft across idle-close.
// Per-origin (sidecar port changes each launch → wiped on .app restart),
// which is the desired scope: drafts shouldn't leak between sessions.
const DRAFT_KEY = "yen-hub:palette-draft";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  // IME composition guard. `e.nativeEvent.isComposing` is unreliable in
  // WKWebView (specifically the macOS 注音/拼音 IMEs we care about — the
  // first Enter that confirms a candidate sometimes arrives WITHOUT the
  // composing flag set, leaking through and sending the message before
  // the composed text lands). A ref toggled by compositionstart/end is
  // the canonical workaround.
  const composingRef = useRef(false);
  const [convo, setConvo] = useState<Convo | null>(null);
  // `collapsed` retained as a frozen `false` — the conditional branches
  // below still reference it. Removing it would touch too many call
  // sites for a behaviour change this small.
  const collapsed = false;
  const [leaving, setLeaving] = useState(false);
  const [holding, setHolding] = useState(false);
  // Always expanded per Yen — the toggle button was removed and the
  // collapse-to-peek stage was deleted. Kept as a const for the
  // conditional branches below.
  const userExpanded = true;

  // Wheel-tracking offset. Mouse wheel up/down inside the palette area
  // translates the whole assembly vertically, so the chat "follows" the
  // gesture. motion.drag also writes to this motionValue, so drag + wheel
  // compose naturally.
  const wheelY = useMotionValue(0);
  useEffect(() => {
    if (!open) wheelY.set(0);
  }, [open, wheelY]);

  // While palette is open, prevent the page behind from scrolling — the
  // wheel gesture should drive the chat, not the hub overview underneath.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Token is fetched once on mount and stored in a ref so the transport's
  // headers function is synchronous (async headers tripped a ByteString
  // conversion bug in the AI SDK v6 request builder when paired with
  // certain providers).
  const tokenRef = useRef<string>("");
  useEffect(() => {
    tokenRef.current = getSidecarToken();
  }, []);

  // Slice 7.7: pass the active conversation id to the chat route so the
  // server can mirror Duffy's response into the inflight store. Header
  // stays in sync via a ref because the transport's headers function is
  // synchronous (and called per request).
  const convoIdRef = useRef<string>("");
  useEffect(() => {
    convoIdRef.current = convo?.id ?? "";
  }, [convo?.id]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: (): Record<string, string> => {
        const h: Record<string, string> = {};
        if (tokenRef.current) h["X-Yen-Token"] = tokenRef.current;
        if (convoIdRef.current) h["X-Conversation-Id"] = convoIdRef.current;
        return h;
      },
    }),
  });

  // Hydrate conversation on first open + reconcile any inflight response
  // that Duffy finished (or is still finishing) while the palette was
  // closed. Slice 7.7 + Slice 8.7 (server-side conversations).
  useEffect(() => {
    if (!open || convo) return;
    let cancelled = false;
    (async () => {
      // Slice 8.7 — load cache from server before reading. localStorage
      // doesn't survive port churn; the server JSON does.
      await loadFromServer();
      if (cancelled) return;
      const c = ensureActive();
      setConvo(c);
      if (c.messages.length > 0) setMessages(c.messages);
      void reconcileInflight(c.id, c.messages as UIMessage[], (next) => {
        setMessages(next);
        saveConversation({
          ...c,
          messages: next,
          updatedAt: Date.now(),
        });
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // New-conversation choreography (Slice 7.7+):
  //   t=0       Duffy finishes his "<<NEW_CONVERSATION>>" acknowledgement.
  //   1.2s      Yen has read it. Start "shrinking-messages":
  //             chat history collapses + slides down.
  //   +0.55s    Start "iris-close": command line shrinks horizontally
  //             toward centre.
  //   +0.45s    State swap: createConversation + setMessages([]).
  //             Phase → "iris-open": command line expands back out.
  //   +0.5s     Phase → "breathing": brief settled pause.
  //   +0.35s    Send the GREET_INIT sentinel as a hidden user message;
  //             Duffy responds with one short greeting per his SOUL.
  //             Phase → "idle".
  //
  // Net effect: Yen sees the room collapse, the door close, the door
  // open onto an empty room, and Duffy spontaneously say hello.
  const [newConvoPhase, setNewConvoPhase] = useState<NewConvoPhase>("idle");
  const newConvoTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const clearNewConvoTimers = () => {
    newConvoTimers.current.forEach((t) => clearTimeout(t));
    newConvoTimers.current = [];
  };
  useEffect(() => {
    if (status === "streaming" || status === "submitted") return;
    if (messages.length === 0) return;
    if (newConvoPhase !== "idle") return; // already running
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    const text = (lastAssistant.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (!NEW_CONVERSATION_SENTINEL.test(text)) return;

    const T = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      newConvoTimers.current.push(t);
    };

    // Timing budget — animations need HOLD time at their target value so
    // the eye actually perceives "closed" before the next phase reopens
    // them. Each phase duration is animation + visible hold.
    //
    //   shrink   700ms (0.55s anim + 150ms settle)
    //   iris-close 800ms (0.4s anim to scaleX=0 + 400ms hold AT 0)
    //   iris-open 700ms (0.45s anim to scaleX=1 + 250ms settle)
    //   breathing 500ms (a beat of stillness before the greeting)

    // Phase 1 — read pause, then shrink messages.
    T(1200, () => {
      setNewConvoPhase("shrinking-messages");
    });
    // Phase 2 — iris-close (collapses + HOLDS at scaleX=0 for ~400ms).
    T(1200 + 700, () => {
      setNewConvoPhase("iris-close");
    });
    // Phase 3 — state swap + iris-open. Happens at the END of the hold
    // so the swap is invisible (palette is fully collapsed).
    T(1200 + 700 + 800, () => {
      const fresh = createConversation();
      setConvo(fresh);
      setMessages([]);
      setInput("");
      setNewConvoPhase("iris-open");
    });
    // Phase 4 — settled breathing pause.
    T(1200 + 700 + 800 + 700, () => {
      setNewConvoPhase("breathing");
    });
    // Phase 5 — Duffy auto-greets via hidden sentinel; back to idle.
    T(1200 + 700 + 800 + 700 + 500, () => {
      setNewConvoPhase("idle");
      sendMessage({ text: GREET_INIT_SENTINEL });
    });

    return clearNewConvoTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, status]);

  // Persist when streaming completes
  useEffect(() => {
    if (!convo) return;
    if (status === "streaming" || status === "submitted") return;
    if (messages.length === 0) return;
    const updated: Convo = {
      ...convo,
      messages: messages as UIMessage[],
      title: convo.title ?? deriveTitle(messages as UIMessage[]),
      updatedAt: Date.now(),
    };
    saveConversation(updated);
    if (updated.title !== convo.title) setConvo(updated);
  }, [messages, status, convo]);

  // Auto-scroll messages to bottom on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // Slice 8.6 — broadcast Duffy's chat status to the rest of the app
  // (specifically DuffyBadge on Page A) so the badge can show
  // "breathing while thinking" / "lit while fresh reply waits".
  // We use a window CustomEvent rather than a shared store/context
  // because the badge sits in a separate React tree.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("yen-duffy-status", {
        detail: { status, paletteOpen: open },
      }),
    );
  }, [status, open]);

  // Reset leaving state whenever we open
  useEffect(() => {
    if (open) setLeaving(false);
  }, [open]);

  // On open: slide from ~120px above the latest message down to it,
  // AND immediately trigger the 1.2s breath on the command line.
  // (Previously the breath waited for the slide to land via nested
  // setTimeout — that race made the first open skip the breath.)
  const [openPulse, setOpenPulse] = useState(false);
  useEffect(() => {
    if (!open) {
      setOpenPulse(false);
      return;
    }
    // Kick the pulse immediately. React will commit `open-breath` on
    // the next render, the CSS animation starts, 1.2s later we clear.
    setOpenPulse(true);
    const pulseOff = window.setTimeout(() => setOpenPulse(false), 1200);

    // Slide-in: scrollTop starts ~120px above bottom, eases to bottom.
    // Runs in parallel with the pulse.
    const el = scrollRef.current;
    const rafIds: number[] = [];
    if (el) {
      rafIds.push(
        requestAnimationFrame(() => {
          const target = el.scrollHeight;
          const start = Math.max(0, target - 120);
          el.scrollTop = start;
          const t0 = performance.now();
          const DUR = 700;
          const animate = (now: number) => {
            const p = Math.min(1, (now - t0) / DUR);
            const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
            el.scrollTop = start + (target - start) * eased;
            if (p < 1) rafIds.push(requestAnimationFrame(animate));
          };
          rafIds.push(requestAnimationFrame(animate));
        }),
      );
    }

    return () => {
      window.clearTimeout(pulseOff);
      rafIds.forEach((id) => cancelAnimationFrame(id));
    };
  }, [open]);

  // Single-stage inactivity close (was: 3s collapse → 5s close).
  // Activity (typing / new messages / mouse hold) resets the timer.
  useEffect(() => {
    if (!open || leaving || holding) return;
    const t = setTimeout(() => {
      setLeaving(true);
      setTimeout(() => setOpen(false), FADE_MS);
    }, INACTIVITY_CLOSE_MS);
    return () => clearTimeout(t);
  }, [input, status, messages, open, leaving, holding]);

  // Global keyboard listener — Space-to-summon (was: any-printable-key).
  // Per spec, only the spacebar opens the palette; other characters
  // (letters, digits, punctuation, IME composition) are no longer
  // triggers, so casual typing on Page A doesn't accidentally summon.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Esc → fade out (matches the auto-close behaviour)
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setLeaving(true);
        setTimeout(() => setOpen(false), FADE_MS);
        return;
      }
      // ⌘K → toggle empty
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // ⌘. → interrupt Duffy mid-stream (matches macOS convention for
      // "cancel current operation"). Only meaningful while streaming;
      // silently ignored otherwise so the chord stays harmless.
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        if (status === "streaming" || status === "submitted") {
          e.preventDefault();
          stop();
        }
        return;
      }
      // Already open OR target is editable → let it pass
      if (open || isEditableTarget(e.target)) return;
      // Only the spacebar triggers — and only when no modifier is held
      // (Ctrl/Cmd/Alt+Space should pass through to OS shortcuts).
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      // Don't clear input on summon — the restore-from-sessionStorage
      // effect below brings back any draft the user had when the palette
      // last auto-closed. preventDefault() above already swallows the
      // space keystroke, so no risk of inserting " " into the textarea.
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, status, stop]);

  // Restore unsent draft from sessionStorage on mount, persist on every
  // change. Cleared after a successful send (see send()).
  // sessionStorage is per-origin and the sidecar port changes each
  // launch → drafts live for the current .app session only, which is
  // the right scope.
  useEffect(() => {
    try {
      const draft = window.sessionStorage.getItem(DRAFT_KEY);
      if (draft) setInput(draft);
    } catch {
      /* sessionStorage disabled (private mode etc.) — silent */
    }
  }, []);
  useEffect(() => {
    try {
      if (input) window.sessionStorage.setItem(DRAFT_KEY, input);
      else window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      /* silent */
    }
  }, [input]);

  // Focus + caret-to-end when the palette opens. preventScroll stops
  // the browser from scrolling an ancestor scroll container to bring
  // the freshly-focused textarea into view — without this, summoning
  // the palette while the page is scrolled would yank it back to top.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    });
  }, [open]);

  // Auto-grow textarea
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input, open]);

  /** Start a fresh conversation — wired to `/new` slash command. */
  const startNew = useCallback(() => {
    if (status === "streaming") stop();
    const c = createConversation();
    setConvo(c);
    setMessages([]);
    setInput("");
  }, [status, stop, setMessages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;

    // Slash-command parser. Cheap for now; expandable later.
    if (text === "/new") {
      startNew();
      return;
    }
    if (text === "/stop") {
      if (status === "streaming") stop();
      setInput("");
      return;
    }
    if (text === "/close" || text === "/exit") {
      setOpen(false);
      return;
    }

    if (status === "streaming" || status === "submitted") return;
    sendMessage({ text });
    setInput("");
  }, [input, status, sendMessage, stop, startNew]);

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      // Belt + braces against IME leakage:
      //   - e.nativeEvent.isComposing — Chromium/standard signal
      //   - e.keyCode === 229 — legacy IME-pending signal still respected by WKWebView
      //   - composingRef — our own onCompositionStart/End tracker (catches the
      //     case where Enter confirms the candidate but the flag has already
      //     flipped to false at keydown time)
      !e.nativeEvent.isComposing &&
      e.keyCode !== 229 &&
      !composingRef.current
    ) {
      e.preventDefault();
      send();
    }
  };

  if (!open) return null;

  const isThinking = status === "submitted" || status === "streaming";

  // Bump activity → resets close + collapse timers via "holding" toggle.
  const bump = () => {
    setHolding(true);
    // release on next tick — the "press" was enough to reset
    setTimeout(() => setHolding(false), 50);
  };

  // Backdrop wheel → translate the assembly. Bounded to a reasonable
  // range so the user can't fling it off-screen. Bump resets the idle
  // collapse timer.
  function onPaletteWheel(e: React.WheelEvent<HTMLDivElement>) {
    const next = wheelY.get() + e.deltaY * 0.6;
    const clamped = Math.max(-300, Math.min(300, next));
    wheelY.set(clamped);
    bump();
  }

  // Portal directly to document.body — the overview's outermost wrapper
  // is a motion.div with framer-motion's transform/will-change, which
  // establishes a containing block for position:fixed descendants. That
  // turned this overlay's `fixed` into effectively `absolute` of that
  // wrapper, so the palette tracked page scroll instead of staying
  // glued to the viewport. document.body has no transform/filter (the
  // backdrop-filter lives on html now), so a portal there gives the
  // palette a clean viewport-relative containing block.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setLeaving(true);
          setTimeout(() => setOpen(false), FADE_MS);
        }
      }}
      onWheel={onPaletteWheel}
      style={{
        // 2026-06-04 redesign: backdrop is fully transparent. The palette
        // and message panel each carry their own light frosted-glass so
        // the user can see / drag against the page underneath.
        background: "transparent",
      }}
    >
      {/* Full-viewport noise + tint removed (2026-06-04). The new design
          lets the page show through; per-element frosted glass below
          gives the palette its own surface. */}
      {/* Centering wrapper — flex centers the motion.div based on its
          actual rendered size. Done at this layer (NOT via Tailwind
          translate utilities on motion.div) because motion's style.y
          and drag transforms would override Tailwind's translate(-50%)
          and break the centering. */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
      >
      <motion.div
        drag
        dragMomentum={false}
        dragElastic={0.05}
        dragConstraints={{ left: -400, right: 400, top: -300, bottom: 300 }}
        initial={false}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={{
          opacity: { duration: leaving ? FADE_MS / 1000 : 0.3, ease: "easeOut" },
        }}
        className="w-full max-w-2xl px-8 pointer-events-none"
        style={{
          // Hard ceiling on the whole assembly so it can never overflow
          // the Tauri webview. Flex parent centers; assembly cap keeps
          // both edges inside the viewport at any window size.
          maxHeight: "85vh",
          cursor: holding ? "grabbing" : "grab",
          // Wheel-tracked vertical offset, additive to motion's drag y.
          // Lives on motion.div's transform — the flex wrapper does the
          // centering, this just biases from that anchor.
          y: wheelY,
        }}
        onMouseDown={() => setHolding(true)}
        onMouseUp={() => setHolding(false)}
        onMouseLeave={() => setHolding(false)}
        onWheel={bump}
      >
        {/* Inner wrapper handles the collapse "rise + shrink" purely via
            CSS transform (GPU). Keeps Motion's drag transform clean on
            the outer wrapper. */}
        <div
          className="flex flex-col"
          style={{
            transform: `translateY(${collapsed ? "-19vh" : "0vh"})`,
            transition: "transform 2.5s cubic-bezier(0.22, 1, 0.36, 1)",
            willChange: "transform",
          }}
        >
        {/* Vignette removed — it was a soft dark radial behind the chat
            that moved with motion.div on drag, leaving a visible
            rectangular halo against the new uniform backdrop blur. */}
        {/* Messages — always rendered. Container height animates between
            full (expanded) and ~24px (collapsed peek). Older turns fade
            out during collapse so only the last line reads as "peek". */}
        {messages.length > 0 && (() => {
          // Cap by TURN COUNT, not pixel height — the box grows naturally
          // with content up to N turns regardless of how many lines each
          // turn occupies. collapsed peek shows just the most recent turn.
          const visibleTurns = collapsed
            ? 1
            : userExpanded
              ? 10
              : 3;
          const visible = messages.slice(-visibleTurns);
          return (
            <motion.div
              ref={scrollRef}
              className="pointer-events-auto mb-6 hub-scrollbar"
              // Iris-open on first mount — messages container expands
              // from center together with the command line, only when
              // the palette itself is being summoned. The new-conversation
              // flow uses the existing maxHeight-shrink path (NOT scaleX),
              // so the messages container stays "horizontally normal" and
              // only collapses vertically there.
              //
              // maxHeight ALSO starts at 0 so the assembly grows from
              // short → tall in lockstep with scaleX; otherwise the
              // command-line below appears to slam down into place when
              // the flex parent re-centers an instantly-full-height
              // (but invisible) message panel.
              initial={{ scaleX: 0, opacity: 0, maxHeight: 0 }}
              // Tighter caps so the WHOLE assembly fits well inside
              // the Tauri webview no matter the window size. Assembly
              // total ≈ messages_max + 24 (mb-6) + ~52 (input). Caps
              // below leave generous top/bottom breathing room so the
              // user never sees an edge hit the window.
              animate={{
                scaleX: leaving ? 0 : 1,
                maxHeight:
                  newConvoPhase === "shrinking-messages" ||
                  newConvoPhase === "iris-close" ||
                  newConvoPhase === "iris-open" ||
                  newConvoPhase === "breathing"
                    ? 0
                    : collapsed
                      ? 36
                      : userExpanded
                        ? "calc(70vh - 100px)"
                        : "calc(35vh - 50px)",
                opacity:
                  leaving ||
                  newConvoPhase === "shrinking-messages" ||
                  newConvoPhase === "iris-close" ||
                  newConvoPhase === "iris-open" ||
                  newConvoPhase === "breathing"
                    ? 0
                    : 1,
                y:
                  newConvoPhase === "shrinking-messages" ||
                  newConvoPhase === "iris-close"
                    ? 32
                    : 0,
              }}
              transition={{
                duration: leaving
                  ? 0.4
                  : newConvoPhase === "shrinking-messages"
                    ? 0.55
                    : collapsed || userExpanded
                      ? 1.2
                      : 0.45,
                ease: leaving
                  ? [0.7, 0, 0.84, 0]
                  : [0.22, 1, 0.36, 1],
              }}
              style={{
                overflowY: collapsed ? "hidden" : "auto",
                overflowX: "hidden",
                // Local frosted glass + accent ring — matches the aura
                // on the command line below (both driven by --palette-accent).
                background: "rgba(20, 22, 28, 0.45)",
                border: "1px solid rgba(var(--palette-accent-rgb), 0.18)",
                borderRadius: "12px",
                padding: "16px",
                boxShadow:
                  "0 0 0 1px rgba(var(--palette-accent-rgb), 0.10)," +
                  " 0 6px 24px rgba(0,0,0,0.35)," +
                  " 0 0 32px rgba(var(--palette-accent-rgb), 0.14)",
                backdropFilter: "blur(10px) saturate(0.9)",
                WebkitBackdropFilter: "blur(10px) saturate(0.9)",
                transformOrigin: "center",
              }}
              onClick={(e) => e.stopPropagation()}
              // Wheel inside the messages container scrolls its own
              // content; don't let it bubble up to also translate the
              // whole chat assembly.
              onWheel={(e) => e.stopPropagation()}
            >
              <div className={collapsed ? "space-y-0" : "space-y-6"}>
                {visible.map((m, i) => {
                  const isLast = i === visible.length - 1;
                  const isUser = m.role === "user";
                  // Hide the GREET_INIT synthetic user message so visually
                  // it looks like Duffy spontaneously says hello.
                  if (isUser) {
                    const t = (m.parts ?? [])
                      .filter(
                        (p): p is { type: "text"; text: string } =>
                          p.type === "text",
                      )
                      .map((p) => p.text)
                      .join("");
                    if (t.trim() === GREET_INIT_SENTINEL) return null;
                  }
                  return (
                    <motion.div
                      key={m.id}
                      animate={{
                        opacity: collapsed && !isLast ? 0 : 1,
                      }}
                      transition={{ duration: 0.35, ease: "easeOut" }}
                      className={`flex ${
                        isUser ? "justify-end" : "justify-start"
                      }`}
                    >
                      <div className={isUser ? "max-w-[78%]" : "w-full"}>
                        <Turn
                          role={m.role}
                          parts={m.parts}
                          clamped={collapsed}
                        />
                      </div>
                    </motion.div>
                  );
                })}
                {isThinking &&
                  visible[visible.length - 1]?.role === "user" &&
                  !collapsed && (
                    <div className="text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase flex items-center gap-2">
                      <span className="inline-block h-1 w-1 rounded-full bg-[var(--fg-2)] hairline-pulse" />
                      thinking
                    </div>
                  )}
              </div>
            </motion.div>
          );
        })()}

        {/* The command line — subtle bar so it's discoverable but not
            heavy. When the agent is thinking, the entire bar breathes
            via `thinking-pulse` (warm glow on the border + outer
            shadow). Replaces the previous separate hairline below.
            On new-conversation choreography, scaleX iris-closes then
            iris-opens around the swap. */}
        <motion.div
          className={`pointer-events-auto flex items-end gap-3 rounded-xl px-4 py-3 ${
            openPulse
              ? "open-breath"
              : isThinking
                ? "thinking-pulse"
                : ""
          }`}
          // Iris entrance/exit reused from the new-conversation choreography:
          //   - mount: scaleX 0 → 1 (open)
          //   - leaving (idle/Esc/⌘K close): scaleX 1 → 0
          //   - newConvoPhase=iris-close: same 1 → 0 mid-session
          // transformOrigin: center makes it "fold out from the middle"
          // matching the new-convo iris-open feel.
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{
            scaleX:
              leaving || newConvoPhase === "iris-close" ? 0 : 1,
            opacity: leaving ? 0 : 1,
          }}
          transition={{
            duration:
              leaving || newConvoPhase === "iris-close" ? 0.4 : 0.45,
            ease:
              leaving || newConvoPhase === "iris-close"
                ? [0.7, 0, 0.84, 0]
                : [0.16, 1, 0.3, 1],
          }}
          style={{
            background: "rgba(20, 22, 28, 0.55)",
            // Option B aura — color driven by --palette-accent (sky-blue
            // by default; decoupled from --accent so the palette can be
            // re-tinted without touching the rest of the hub).
            border: "1px solid rgba(var(--palette-accent-rgb), 0.35)",
            boxShadow:
              // inner top sheen (subtle)
              "inset 0 1px 0 rgba(255,255,255,0.06)," +
              // tight accent ring (1px halo right at the edge)
              " 0 0 0 1px rgba(var(--palette-accent-rgb), 0.18)," +
              // depth shadow (palette feels lifted)
              " 0 8px 32px rgba(0,0,0,0.40)," +
              // soft outer aura
              " 0 0 40px rgba(var(--palette-accent-rgb), 0.22)",
            // Local frosted glass — only the palette itself blurs what's
            // behind it, the rest of the viewport stays sharp.
            backdropFilter: "blur(12px) saturate(0.9)",
            WebkitBackdropFilter: "blur(12px) saturate(0.9)",
            transformOrigin: "center",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="pb-2 text-[11px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase select-none">
            ›
          </span>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKey}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder="ask anything"
            rows={1}
            className="flex-1 resize-none bg-transparent text-[16px] leading-relaxed text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none"
          />
          {/* Stop button — visible only while Duffy is streaming, so the
              user can interrupt without typing /stop. ⌘. is the global
              shortcut (see keydown handler above). */}
          {isThinking && (
            <button
              type="button"
              onClick={() => stop()}
              title="Stop generating (⌘.)"
              className="ml-2 flex h-7 items-center gap-1.5 rounded-md border border-white/20 bg-white/[0.04] px-2.5 text-[11px] font-mono tracking-[0.16em] uppercase text-[var(--fg-1)] hover:text-[var(--fg-0)] hover:border-white/40 transition-colors"
            >
              <span
                aria-hidden
                className="block h-2.5 w-2.5 bg-current"
              />
              <span>stop</span>
              <span className="text-[var(--fg-3)]">⌘.</span>
            </button>
          )}
          {/* Expand toggle removed per Yen — palette is now always
              fully expanded while open. */}
        </motion.div>

        {/* Hairline under the input removed — the breathing effect
            now lives on the command-line wrapper itself. */}
        </div>
      </motion.div>
      </div>
    </div>,
    document.body,
  );
}

function Turn({
  role,
  parts,
  clamped,
}: {
  role: "user" | "assistant" | "system";
  parts: Array<{ type: string; text?: string }>;
  clamped?: boolean;
}) {
  const isUser = role === "user";
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");

  // In clamped (peek) mode: hide role label and clamp text to one line.
  // The label is animated out via motion's height tween implicitly through
  // CSS transition since it's display:block always.
  const renderBody = () => {
    // In clamped peek mode we always want plain one-line text, no cards.
    if (clamped) {
      return (
        <div
          className="text-[14px] leading-relaxed whitespace-nowrap overflow-hidden text-ellipsis"
          style={{
            color: isUser
              ? "rgba(255, 255, 255, 0.42)"
              : "rgba(255, 255, 255, 0.62)",
          }}
          title={text}
        >
          {text.replace(/\s+/g, " ").trim()}
        </div>
      );
    }

    // Assistant messages may carry Duffy intent sentinels. Split text into
    // (text | intent-card | text | intent-card | …) segments preserving
    // order so context reads naturally.
    //
    // Note: `matchAll` is safe on a module-scoped /g regex; `.test()` would
    // advance lastIndex and break across re-renders. Don't use it.
    if (!isUser) {
      const matches = [...text.matchAll(INTENT_SENTINEL)];
      if (matches.length > 0) {
        const segments: Array<
          { type: "text"; text: string } | { type: "intent"; id: string }
        > = [];
        let lastIndex = 0;
        for (const m of matches) {
          const idx = m.index ?? 0;
          if (idx > lastIndex) {
            segments.push({ type: "text", text: text.slice(lastIndex, idx) });
          }
          segments.push({ type: "intent", id: m[1] });
          lastIndex = idx + m[0].length;
        }
        if (lastIndex < text.length) {
          segments.push({ type: "text", text: text.slice(lastIndex) });
        }
        return (
          <div className="text-[14px] leading-relaxed">
            {segments.map((seg, i) =>
              seg.type === "text" ? (
                <span
                  key={i}
                  className="whitespace-pre-wrap"
                  style={{ color: "rgba(255, 255, 255, 0.62)" }}
                >
                  {seg.text}
                </span>
              ) : (
                <IntentCard key={i} intentId={seg.id} />
              ),
            )}
          </div>
        );
      }
    }

    return (
      <div
        className="text-[14px] leading-relaxed whitespace-pre-wrap"
        style={{
          color: isUser
            ? "rgba(255, 255, 255, 0.42)"
            : "rgba(255, 255, 255, 0.62)",
        }}
      >
        {text}
      </div>
    );
  };

  return (
    <div className={isUser ? "text-right" : ""}>
      <div
        className="mb-1 text-[10px] font-mono tracking-[0.32em] text-[var(--warn)] uppercase overflow-hidden"
        style={{
          maxHeight: clamped ? 0 : 16,
          opacity: clamped ? 0 : 1,
          marginBottom: clamped ? 0 : 4,
          transition: "max-height 1200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 900ms ease-out, margin-bottom 1200ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {isUser ? "you" : "duffy"}
      </div>
      {renderBody()}
    </div>
  );
}
