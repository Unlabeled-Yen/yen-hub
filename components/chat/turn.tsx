"use client";

/**
 * Turn — renders a single conversation message (role label + body).
 *
 * Extracted from command-palette.tsx (Slice: sidebar nav) so the message
 * renderer can be reused outside the palette — including inline Duffy intent
 * cards — without duplicating the sentinel-splitting logic.
 *
 * The `parts` signature is intentionally loose so both the AI SDK's
 * `UIMessage["parts"]` (palette, live stream) and the parts loaded from the
 * conversation store / [id] API satisfy it without casting.
 */

import { IntentCard } from "@/components/agent/intent-card";

/** Sentinel format Duffy embeds in chat to surface an approval card inline.
 *  See `lib/agent/duffy/prompt.ts` and `lib/agent/duffy/agent.ts`. */
export const INTENT_SENTINEL = /<<INTENT:(int_[A-Za-z0-9-]+)>>/g;

/** Root fix (2026-06-15): approval cards are driven by intents Duffy ACTUALLY
 *  created this turn — the `status: "pending"` outputs of propose_* tool calls
 *  carried in the assistant message's parts — not by trusting the model's
 *  <<INTENT:id>> text. Flight recorder turn_mqf55thu proved the model can
 *  narrate "兩個任務已建立" with hand-typed fake UUIDs and zero tool calls; a
 *  text sentinel alone must never be able to conjure (or, via omission, hide) a
 *  card. Tool results are server-side truth. */
export function collectPendingIntentIds(
  parts: Array<{ type: string; output?: unknown }>,
): string[] {
  const ids: string[] = [];
  for (const p of parts) {
    if (!p.type.startsWith("tool-")) continue;
    const out = p.output as { intent_id?: unknown; status?: unknown } | undefined;
    if (out && out.status === "pending" && typeof out.intent_id === "string") {
      ids.push(out.intent_id);
    }
  }
  return ids;
}

export function Turn({
  role,
  parts,
  clamped,
}: {
  role: "user" | "assistant" | "system";
  parts: Array<{ type: string; text?: string; output?: unknown }>;
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
      // Cards are driven by intents actually created this turn (propose_* tool
      // outputs, see collectPendingIntentIds) cross-checked against the text
      // sentinels Duffy emitted. A sentinel positions its card inline; the
      // IntentCard itself re-validates against the store (a fabricated id 404s
      // into the invalid-intent warning). A real pending intent the model
      // forgot to sentinel is appended so it can't silently vanish.
      const realPending = collectPendingIntentIds(parts);
      const matches = [...text.matchAll(INTENT_SENTINEL)];
      if (matches.length > 0 || realPending.length > 0) {
        const segments: Array<
          { type: "text"; text: string } | { type: "intent"; id: string }
        > = [];
        const placed = new Set<string>();
        let lastIndex = 0;
        for (const m of matches) {
          const idx = m.index ?? 0;
          const id = m[1];
          if (idx > lastIndex) {
            segments.push({ type: "text", text: text.slice(lastIndex, idx) });
          }
          lastIndex = idx + m[0].length; // strip the control token from text
          if (!placed.has(id)) {
            placed.add(id);
            segments.push({ type: "intent", id });
          }
        }
        if (lastIndex < text.length) {
          segments.push({ type: "text", text: text.slice(lastIndex) });
        }
        for (const id of realPending) {
          if (!placed.has(id)) {
            placed.add(id);
            segments.push({ type: "intent", id });
          }
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
