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
import { getSidecarToken } from "@/lib/security/sidecar-token";
import {
  createConversation,
  deriveTitle,
  ensureActive,
  saveConversation,
  type Conversation as Convo,
} from "@/lib/conversations/store";

/** Sentinel format Duffy embeds in chat to surface an approval card inline.
 *  See `lib/agent/duffy/prompt.ts` and `lib/agent/duffy/agent.ts`. */
const INTENT_SENTINEL = /<<INTENT:(int_[A-Za-z0-9-]+)>>/g;

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

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
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
    void getSidecarToken().then((t) => {
      tokenRef.current = t;
    });
  }, []);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      headers: (): Record<string, string> =>
        tokenRef.current ? { "X-Yen-Token": tokenRef.current } : {},
    }),
  });

  // Hydrate conversation on first open
  useEffect(() => {
    if (!open || convo) return;
    const c = ensureActive();
    setConvo(c);
    if (c.messages.length > 0) setMessages(c.messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  // Reset leaving state whenever we open
  useEffect(() => {
    if (open) setLeaving(false);
  }, [open]);

  // On open: start the scroll position a bit ABOVE the latest message,
  // then ease down to it. After it lands, kick a two-cycle breath on
  // the command line. Together this reads as "the conversation slid
  // back into view and settled."
  const [openPulse, setOpenPulse] = useState(false);
  useEffect(() => {
    if (!open) {
      setOpenPulse(false);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    // rAF so layout is settled before measuring.
    const rafIds: number[] = [];
    const timeouts: number[] = [];
    rafIds.push(
      requestAnimationFrame(() => {
        const target = el.scrollHeight;
        const start = Math.max(0, target - 120); // 120px above bottom
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
        // After the slide lands, breathe ONE quick cycle via the
        // open-breath class (0.7s total).
        timeouts.push(
          window.setTimeout(() => {
            setOpenPulse(true);
            timeouts.push(
              window.setTimeout(() => setOpenPulse(false), 700),
            );
          }, DUR),
        );
      }),
    );
    return () => {
      rafIds.forEach((id) => cancelAnimationFrame(id));
      timeouts.forEach((id) => window.clearTimeout(id));
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
      // Already open OR target is editable → let it pass
      if (open || isEditableTarget(e.target)) return;
      // Only the spacebar triggers — and only when no modifier is held
      // (Ctrl/Cmd/Alt+Space should pass through to OS shortcuts).
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setInput(""); // no prefill — space is the trigger, not content
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

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
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.nativeEvent.isComposing) {
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
        // Stronger blur + deeper tint than before. When the user
        // pushes the chat to fully-expanded mode the tint bumps up
        // again so the conversation reads on top of an even quieter
        // backdrop.
        // Lower blur strength + heavier tint than the previous pass —
        // strong blur scatters bright pixels behind into halos around
        // text. Pulling blur down ~30% and lifting the dark tint masks
        // most of that bleed while keeping the "frosted" feel.
        background: leaving
          ? "rgba(0,0,0,0)"
          : userExpanded
            ? "rgba(0,0,0,0.58)"
            : "rgba(0,0,0,0.36)",
        backdropFilter: leaving
          ? "blur(0px)"
          : userExpanded
            ? "blur(14px) saturate(0.85)"
            : "blur(9px) saturate(0.9)",
        WebkitBackdropFilter: leaving
          ? "blur(0px)"
          : userExpanded
            ? "blur(14px) saturate(0.85)"
            : "blur(9px) saturate(0.9)",
        transition: `background ${FADE_MS}ms ease-out, backdrop-filter ${FADE_MS}ms ease-out, -webkit-backdrop-filter ${FADE_MS}ms ease-out`,
      }}
    >
      {/* Noise texture overlay — film-grain on the blurred backdrop so
          the surface reads as glass not flat tint. mix-blend-mode dropped
          (it was washing out on the dark backdrop); white noise applied
          straight at low opacity gives a clear grain. */}
      <svg
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          opacity: leaving ? 0 : 0.10,
          transition: `opacity ${FADE_MS}ms ease-out`,
        }}
        preserveAspectRatio="none"
      >
        <defs>
          <filter id="palette-noise">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.85"
              numOctaves="3"
              seed="3"
              stitchTiles="stitch"
            />
            {/* RGB → white, alpha = original luminance × 0.85.
                That gives high-contrast monochrome grain. */}
            <feColorMatrix
              values="0 0 0 0 1
                      0 0 0 0 1
                      0 0 0 0 1
                      0 0 0 0.85 0"
            />
          </filter>
        </defs>
        <rect width="100%" height="100%" filter="url(#palette-noise)" />
      </svg>
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
              initial={false}
              // Tighter caps so the WHOLE assembly fits well inside
              // the Tauri webview no matter the window size. Assembly
              // total ≈ messages_max + 24 (mb-6) + ~52 (input). Caps
              // below leave generous top/bottom breathing room so the
              // user never sees an edge hit the window.
              animate={{
                maxHeight: collapsed
                  ? 36
                  : userExpanded
                    ? "calc(70vh - 100px)"
                    : "calc(35vh - 50px)",
              }}
              transition={{
                duration: collapsed || userExpanded ? 1.2 : 0.45,
                ease: [0.22, 1, 0.36, 1],
              }}
              style={{
                overflowY: collapsed ? "hidden" : "auto",
                overflowX: "hidden",
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
            shadow). Replaces the previous separate hairline below. */}
        <div
          className={`pointer-events-auto flex items-end gap-3 rounded-xl px-4 py-3 ${
            openPulse
              ? "open-breath"
              : isThinking
                ? "thinking-pulse"
                : ""
          }`}
          style={{
            background: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.10)",
            boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
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
            placeholder="ask anything"
            rows={1}
            className="flex-1 resize-none bg-transparent text-[16px] leading-relaxed text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none"
          />
          {/* Expand toggle removed per Yen — palette is now always
              fully expanded while open. */}
        </div>

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
