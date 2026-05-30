"use client";

/**
 * CommandPalette — type-to-summon overlay (Linear / Arc style).
 *
 * Triggers:
 *   - Any printable key (alphanum, punctuation) → open + prefill that char
 *   - ⌘K → open empty
 *   - Esc → close
 *   - Click outside → close
 *
 * Inside: the AI conversation. Uses the same useChat + localStorage
 * persistence from Slice 3.
 */

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createConversation,
  deriveTitle,
  ensureActive,
  saveConversation,
  type Conversation as Convo,
} from "@/lib/conversations/store";

/** Is the focused element an editable input/textarea/contenteditable? */
function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

/** A key event represents a printable character (a, 1, !, 中) — not Cmd/Ctrl/etc. */
function isPrintable(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key.length !== 1) return false;       // single grapheme
  return true;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [convo, setConvo] = useState<Convo | null>(null);
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

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // Global keyboard listener — the heart of "type to summon"
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Esc → close
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      // ⌘K → toggle empty
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // Already open OR target is editable → ignore (let the input handle keys)
      if (open || isEditableTarget(e.target)) return;
      // Printable key → open + prefill
      if (isPrintable(e)) {
        e.preventDefault();
        setInput(e.key);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Focus & caret-to-end when palette opens
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
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input, open]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (status === "streaming" || status === "submitted") return;
    sendMessage({ text });
    setInput("");
  }, [input, status, sendMessage]);

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      send();
    }
  };

  const startNew = () => {
    if (status === "streaming") stop();
    const c = createConversation();
    setConvo(c);
    setMessages([]);
    setInput("");
  };

  if (!open) return null;

  const isThinking = status === "submitted" || status === "streaming";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--bg-0)]/40 backdrop-blur-sm pt-[14vh] px-4"
      onClick={(e) => {
        // Click on backdrop closes
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="glass w-full max-w-xl rounded-2xl flex flex-col max-h-[72vh]"
      >
        {/* messages */}
        {messages.length > 0 && (
          <div
            ref={scrollRef}
            className="overflow-y-auto px-6 pt-6 pb-2 flex-1"
          >
            {messages.map((m) => (
              <Turn key={m.id} role={m.role} parts={m.parts} />
            ))}
            {isThinking && messages[messages.length - 1]?.role === "user" && (
              <div className="mt-6 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase flex items-center gap-2">
                <span className="inline-block h-1 w-1 rounded-full bg-[var(--fg-2)] hairline-pulse" />
                thinking
              </div>
            )}
          </div>
        )}

        {/* input bar */}
        <div className={`px-6 py-4 ${messages.length > 0 ? "border-t border-[var(--border-subtle)]" : ""}`}>
          <div className="relative flex items-end gap-3">
            <span className="pb-2 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase select-none">
              ›
            </span>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="ask anything"
              rows={1}
              className="flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-[var(--fg-0)] placeholder:text-[var(--fg-3)] focus:outline-none"
            />
            <div
              className={`absolute -bottom-3 left-0 right-0 h-px bg-[var(--fg-0)] transition-opacity ${
                isThinking ? "hairline-pulse opacity-50" : "opacity-0"
              }`}
            />
          </div>
        </div>

        {/* footer hints */}
        <div className="flex items-center justify-between px-6 pb-3 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-3)] uppercase select-none">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={startNew}
              className="hover:text-[var(--fg-1)] transition-colors"
            >
              + new
            </button>
            {isThinking && (
              <button
                type="button"
                onClick={() => stop()}
                className="hover:text-[var(--danger)] transition-colors"
              >
                stop
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span>esc to close</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Turn({
  role,
  parts,
}: {
  role: "user" | "assistant" | "system";
  parts: Array<{ type: string; text?: string }>;
}) {
  const isUser = role === "user";
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
  return (
    <div className="mt-6 first:mt-0">
      <div className="mb-1 text-[10px] font-mono tracking-[0.32em] text-[var(--fg-2)] uppercase">
        <span className={isUser ? "" : "text-[var(--fg-0)]"}>
          {isUser ? "you" : "yen"}
        </span>
      </div>
      <div
        className={`text-[14px] leading-relaxed whitespace-pre-wrap ${
          isUser ? "text-[var(--fg-1)]" : "text-[var(--fg-0)]"
        }`}
      >
        {text}
      </div>
    </div>
  );
}
