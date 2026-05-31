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
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createConversation,
  deriveTitle,
  ensureActive,
  saveConversation,
  type Conversation as Convo,
} from "@/lib/conversations/store";

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

function isPrintable(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key.length !== 1) return false;
  return true;
}

/** No-activity grace before the conversation collapses to a single-line
 *  peek of the latest turn. */
const COLLAPSE_AFTER_MS = 3000;

/** AFTER reaching the collapsed peek, this long until the palette starts
 *  fading away. Resets whenever activity returns. */
const CLOSE_AFTER_COLLAPSED_MS = 5000;

/** Fade-out duration before the palette unmounts. */
const FADE_MS = 1000;

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [convo, setConvo] = useState<Convo | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [holding, setHolding] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
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

  // Stage 1 — inactivity collapse. Activity resets the timer.
  useEffect(() => {
    setCollapsed(false);
    if (!open || messages.length === 0 || holding) return;
    const t = setTimeout(() => setCollapsed(true), COLLAPSE_AFTER_MS);
    return () => clearTimeout(t);
  }, [input, status, messages, open, holding]);

  // Stage 2 — once collapsed, start the close timer. Any returned
  // activity will flip collapsed back to false (above) and clear this.
  useEffect(() => {
    if (!collapsed || !open || leaving || holding) return;
    const t = setTimeout(() => {
      setLeaving(true);
      setTimeout(() => setOpen(false), FADE_MS);
    }, CLOSE_AFTER_COLLAPSED_MS);
    return () => clearTimeout(t);
  }, [collapsed, open, leaving, holding]);

  // While the container is collapsing, keep the scroll glued to the bottom
  // so the most-recent line stays visible as height shrinks. Without this,
  // overflow clips the LAST message out of view because the scroll stays
  // pinned to where it was when content was tall.
  useEffect(() => {
    if (!collapsed) return;
    let raf = 0;
    const tick = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const stop = setTimeout(() => cancelAnimationFrame(raf), 2800);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(stop);
    };
  }, [collapsed]);

  // Global keyboard listener — heart of "type to summon"
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
      if (!isPrintable(e)) return;

      // IME composition (Chinese / Japanese / Korean):
      // do NOT preventDefault and do NOT prefill — let the focused
      // textarea catch the composition naturally so the first character
      // (which was the IME's bopomofo intermediate) isn't dropped.
      if (e.isComposing) {
        setOpen(true);
        return;
      }

      // Latin printable: capture the key as prefill.
      e.preventDefault();
      setInput(e.key);
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Focus + caret-to-end when the palette opens
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.focus();
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

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setLeaving(true);
          setTimeout(() => setOpen(false), FADE_MS);
        }
      }}
    >
      {/* Draggable, fading column */}
      <motion.div
        drag
        dragMomentum={false}
        dragElastic={0.05}
        dragConstraints={{ left: -400, right: 400, top: -250, bottom: 350 }}
        // Skip first-frame interpolation that caused the palette to
        // appear off-position then snap to target on open.
        initial={false}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={{
          opacity: { duration: leaving ? FADE_MS / 1000 : 0.3, ease: "easeOut" },
        }}
        className="absolute left-1/2 -translate-x-1/2 w-full max-w-2xl px-8 pointer-events-none"
        style={{
          bottom: "25vh",
          cursor: holding ? "grabbing" : "grab",
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
        {/* Vignette — very soft, very large. Falls off the visible area
            so no rectangular outline is perceivable; only a gentle
            "ambient light dimming toward the corners" feel. */}
        <div
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            inset: "-300px -260px -340px -260px",
            background:
              "radial-gradient(ellipse 60% 45% at center, transparent 55%, rgba(0,0,0,0.10) 75%, rgba(0,0,0,0.22) 92%, rgba(0,0,0,0.28) 100%)",
            filter: "blur(60px)",
            zIndex: -1,
          }}
        />
        {/* Messages — always rendered. Container height animates between
            full (expanded) and ~24px (collapsed peek). Older turns fade
            out during collapse so only the last line reads as "peek". */}
        {messages.length > 0 && (
          <motion.div
            ref={scrollRef}
            className="pointer-events-auto mb-6"
            initial={false}
            animate={{
              maxHeight: collapsed ? 36 : "42vh",
            }}
            transition={{ duration: 2.5, ease: [0.22, 1, 0.36, 1] }}
            style={{
              overflowY: collapsed ? "hidden" : "auto",
              overflowX: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={collapsed ? "space-y-0" : "space-y-6"}>
              {messages.map((m, i) => {
                const isLast = i === messages.length - 1;
                return (
                  <motion.div
                    key={m.id}
                    animate={{
                      opacity: collapsed && !isLast ? 0 : 1,
                    }}
                    transition={{ duration: 0.35, ease: "easeOut" }}
                  >
                    <Turn role={m.role} parts={m.parts} clamped={collapsed} />
                  </motion.div>
                );
              })}
              {isThinking && messages[messages.length - 1]?.role === "user" && !collapsed && (
                <div className="text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase flex items-center gap-2">
                  <span className="inline-block h-1 w-1 rounded-full bg-[var(--fg-2)] hairline-pulse" />
                  thinking
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* The command line — subtle bar so it's discoverable but not heavy */}
        <div
          className="pointer-events-auto flex items-end gap-3 rounded-xl px-4 py-3"
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
        </div>

        {/* Hairline pulse under the input while streaming. */}
        <div
          className={`pointer-events-none mt-2 h-px bg-[var(--fg-0)] transition-opacity ${
            isThinking ? "hairline-pulse opacity-50" : "opacity-0"
          }`}
        />
        </div>
      </motion.div>
    </div>
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
  return (
    <div>
      <div
        className="mb-1 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase overflow-hidden"
        style={{
          maxHeight: clamped ? 0 : 16,
          opacity: clamped ? 0 : 1,
          marginBottom: clamped ? 0 : 4,
          transition: "max-height 1200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 900ms ease-out, margin-bottom 1200ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {isUser ? "you" : "yen"}
      </div>
      <div
        className={`text-[14px] leading-relaxed ${
          clamped
            ? "whitespace-nowrap overflow-hidden text-ellipsis"
            : "whitespace-pre-wrap"
        }`}
        // Lower-contrast gray-white per role — AI brighter than user
        // so the eye still distinguishes them but neither is stark.
        style={{
          color: isUser
            ? "rgba(255, 255, 255, 0.42)"
            : "rgba(255, 255, 255, 0.62)",
        }}
        title={clamped ? text : undefined}
      >
        {clamped
          ? text.replace(/\s+/g, " ").trim()
          : text}
      </div>
    </div>
  );
}
