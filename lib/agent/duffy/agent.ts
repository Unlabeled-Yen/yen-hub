/**
 * Duffy — Yen's main agent.
 *
 * Slice 6 / Duffy v0: tools + intent approval.
 * Slice 7A: + frozen system prompt with silhouette + current week summary
 * injected once at session start (Hermes pattern). This preserves the LLM
 * prefix cache while giving Duffy persistent context.
 * Slice 7.5: SOUL.md vault-loaded personality (`06 - AI Data/agents/duffy.md`).
 * Slice 7.7: inflight store — keep streamText running even when Yen closes
 * the palette mid-thought; client merges back on reconnect.
 *
 * If no LLM key is configured, returns a 500 JSON instead of pretending to
 * work.
 */

import { NextResponse } from "next/server";
import {
  convertToModelMessages,
  smoothStream,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { duffyTools } from "@/lib/agent/duffy/tools";
import { DUFFY_OPERATIONAL_RULES } from "@/lib/agent/duffy/prompt";
import { loadDuffySoul } from "@/lib/agent/agents/duffy-soul";
import {
  appendInflight,
  finalizeInflight,
  startInflight,
} from "@/lib/agent/duffy/inflight-store";
import {
  getCurrentSilhouette,
  renderSilhouetteForPrompt,
} from "@/lib/agent/storage/silhouettes";
import {
  getCurrentWeekSummary,
  renderSummaryForPrompt,
} from "@/lib/agent/storage/summaries";
import { hasAnyLLMKey, pickModel, modelLabel } from "@/lib/ai/model";

export type DuffyContext = {
  /** Yen's request, with the leading "Duffy" stripped. */
  prompt: string;
  /** Full chat history (UI messages). The leading name is still present in
   * the last user message — that's fine; the model sees it as part of the
   * normal flow. */
  messages: UIMessage[];
  /** Conversation id from the client. When present, runDuffy maintains an
   * inflight entry so that closing the palette doesn't lose the response.
   * Omit for non-conversational invocations (cron, bootstrap, etc.). */
  conversationId?: string;
};

/**
 * Compose the frozen system prompt for a session: identity rules + current
 * silhouette + current week summary. Pre-bootstrap (no silhouette yet) gets
 * an inline note instead, so Duffy knows to offer "introduce yourself".
 */
async function composeSystemPrompt(): Promise<string> {
  // 4-part composition (Hermes-style frozen injection):
  //   1. SOUL    — who Duffy is (vault-editable, personality)
  //   2. RULES   — operational protocol (in code, engineering)
  //   3. SILHOUETTE — Duffy's portrait of Yen (Slice 7A)
  //   4. SUMMARY — current week snapshot (Slice 7A)
  const [soul, sil, sum] = await Promise.all([
    loadDuffySoul(),
    getCurrentSilhouette(),
    getCurrentWeekSummary(),
  ]);
  const parts: string[] = [];
  // 1. SOUL — Yen's writing about Duffy.
  parts.push(
    "# Who you are (SOUL — edited by Yen in `06 - AI Data/agents/duffy.md`)\n\n",
  );
  parts.push(soul);
  // 2. Operational rules.
  parts.push("\n\n---\n\n");
  parts.push(DUFFY_OPERATIONAL_RULES);
  // 3. Silhouette.
  if (sil) {
    parts.push("\n\n---\n\n" + renderSilhouetteForPrompt(sil));
  } else {
    parts.push(
      '\n\n---\n\n# Silhouette of Yen\n\n_(not yet bootstrapped — propose_silhouette_update with field="full" if Yen asks you to introduce yourself or once enough observations have accumulated)_',
    );
  }
  // 4. Current week summary.
  if (sum) {
    parts.push("\n\n---\n\n" + renderSummaryForPrompt(sum));
  } else {
    parts.push(
      "\n\n---\n\n# Current week summary\n\n_(no summary for this week yet — Sunday cron will propose one)_",
    );
  }
  return parts.join("");
}

const GREET_INIT_SENTINEL = "__DUFFY_GREET_INIT__";

/** Client emits this sentinel as a hidden user message right after the
 *  new-conversation animation finishes. Replace it server-side with a
 *  clear instruction so Kimi (which is less reliable than Claude at following
 *  subtle prompt rules) reliably produces a greeting. */
function rewriteGreetSentinel(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return messages;
  const text = (last.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
  if (text !== GREET_INIT_SENTINEL) return messages;
  const rewritten: UIMessage = {
    ...last,
    parts: [
      {
        type: "text",
        text:
          "(系統訊息: Yen 剛打開一個全新對話。請以你 SOUL 中的語氣,用 ONE 短句主動向他打招呼。不要說「您好」、不要 emoji、不要列點、不要呼叫任何工具、不要包含任何 sentinel。)",
      },
    ],
  };
  return [...messages.slice(0, -1), rewritten];
}

export async function runDuffy(ctx: DuffyContext): Promise<Response> {
  if (!hasAnyLLMKey()) {
    return NextResponse.json(
      {
        error:
          "duffy needs an llm key — set KIMI_API_KEY or ANTHROPIC_API_KEY in the env, then restart dev/app.",
      },
      { status: 500 },
    );
  }

  // Slice 7.7+: detect the hidden greet sentinel and rewrite it to a clear
  // instruction. More reliable than depending on the LLM to follow a subtle
  // prompt rule, especially on Kimi K2.6.
  const messages = rewriteGreetSentinel(ctx.messages);

  const systemPrompt = await composeSystemPrompt();

  // Per-turn ID. Used as the inflight key tail; client matches via
  // conversation_id but turnId helps debug "which response is this".
  const turnId = `turn_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  // Single-line console marker. Tail this when something looks wrong.
  console.log(
    `[duffy] provider=${process.env.DUFFY_PROVIDER ?? "(auto)"} ` +
      `model=${process.env.DUFFY_MODEL ?? "(default)"} ` +
      `kimi=${process.env.KIMI_API_KEY ? "yes" : "no"} ` +
      `anthropic=${process.env.ANTHROPIC_API_KEY ? "yes" : "no"} ` +
      `prompt_chars=${systemPrompt.length} ` +
      `convo=${ctx.conversationId ?? "(none)"} ` +
      `turn=${turnId}`,
  );

  const convoId = ctx.conversationId;
  if (convoId) {
    await startInflight({ conversationId: convoId, turnId });
  }

  const result = streamText({
    model: pickModel(),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    tools: duffyTools,
    // Allow up to 5 sequential steps: read → maybe-read-more → propose → text.
    stopWhen: stepCountIs(5),
    // Smooth Kimi's coarse chunks into char-by-char output so Duffy's reply
    // types itself onto the screen instead of dumping in 2-3 big blocks.
    // Chinese has little whitespace so 'word' would still feel chunky —
    // regex `/./` emits per UTF-8 character (Chinese + English alike).
    // 8ms × character ≈ 125 chars/sec, brisk typing feel.
    experimental_transform: smoothStream({
      delayInMs: 8,
      chunking: /./,
    }),
    // Slice 7.7: as Kimi emits text deltas, mirror them into the inflight
    // store so we can recover the response if the client disconnects.
    onChunk({ chunk }) {
      if (!convoId) return;
      if (chunk.type === "text-delta") {
        void appendInflight(convoId, chunk.text);
      }
    },
    // Slice 7.7: on natural completion, finalize the inflight entry with
    // the full text. Client will see this on next /api/chat/inflight read.
    async onFinish({ text, usage }) {
      // Slice 元能力 #1 — record LLM usage for budget tracking. Lazy
      // import + try/catch so observability never breaks the stream.
      try {
        const { recordTokenUsage } = await import(
          "@/lib/agent/storage/token-usage"
        );
        await recordTokenUsage({
          call_site: "duffy-chat",
          model: modelLabel(),
          usage,
          ref: convoId,
        });
      } catch {
        /* swallow */
      }
      if (!convoId) return;
      await finalizeInflight({
        conversationId: convoId,
        status: "done",
        finalText: text,
      });
    },
    onError({ error }) {
      console.error("[duffy] streamText error:", error);
      if (convoId) {
        void finalizeInflight({
          conversationId: convoId,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  return result.toUIMessageStreamResponse({
    onError(error) {
      return error instanceof Error ? error.message : String(error);
    },
  });
}
