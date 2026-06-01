/**
 * Duffy — Yen's main agent. Slice 6 entry point.
 *
 * `runDuffy()` is the single entry; it picks mock vs real internally based on
 * env (MOCK_AI=1 or missing ANTHROPIC_API_KEY → mock). The caller in
 * `app/api/chat/route.ts` only needs to know "Duffy was addressed; here are
 * the messages — give me a Response".
 *
 * Real path: streamText with the duffyTools toolkit, multi-step enabled so
 * Duffy can read → propose → write final text with the intent sentinel.
 *
 * Mock path: side-steps the LLM but creates a real Intent in storage so the
 * approve/reject UI can be developed without burning tokens. The mock emits
 * a sentinel `<<INTENT:int_xxx>>` in its streamed text — the same format the
 * real LLM is instructed to emit — so the chat renderer (Slice 6 step 5)
 * doesn't need to distinguish.
 */

import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { createIntent } from "@/lib/agent/storage/intents";
import { duffyTools } from "@/lib/agent/duffy/tools";
import { DUFFY_PROMPT } from "@/lib/agent/duffy/prompt";
import type { EvidenceRef } from "@/lib/agent/storage/types";

export type DuffyContext = {
  /** Yen's request, with the leading "Duffy" stripped. */
  prompt: string;
  /** Full chat history (UI messages). The leading name is still present in
   * the last user message — that's fine; the model sees it as part of the
   * normal flow. */
  messages: UIMessage[];
};

export async function runDuffy(ctx: DuffyContext): Promise<Response> {
  const mock =
    process.env.MOCK_AI === "1" || !process.env.ANTHROPIC_API_KEY;
  if (mock) return runDuffyMock(ctx);
  return runDuffyReal(ctx);
}

/* -------------------------------------------------------------------------- */
/*  Real path — Claude Sonnet + tools.                                        */
/* -------------------------------------------------------------------------- */

async function runDuffyReal(ctx: DuffyContext): Promise<Response> {
  const result = streamText({
    model: anthropic("claude-sonnet-4-5"),
    system: DUFFY_PROMPT,
    messages: await convertToModelMessages(ctx.messages),
    tools: duffyTools,
    // Allow up to 5 sequential steps: read → maybe-read-more → propose → text.
    stopWhen: stepCountIs(5),
  });
  return result.toUIMessageStreamResponse();
}

/* -------------------------------------------------------------------------- */
/*  Mock path — same shape, no LLM cost.                                      */
/* -------------------------------------------------------------------------- */

function sseStream(
  handler: (send: (obj: object) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        await handler(send);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send({ type: "error", errorText: msg });
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

async function streamPlain(
  send: (obj: object) => void,
  text: string,
  ids: { textId: string },
  perCharMs = 18,
): Promise<void> {
  send({ type: "text-start", id: ids.textId });
  for (const ch of Array.from(text)) {
    await new Promise((r) => setTimeout(r, perCharMs));
    send({ type: "text-delta", id: ids.textId, delta: ch });
  }
  send({ type: "text-end", id: ids.textId });
}

export async function runDuffyMock(ctx: DuffyContext): Promise<Response> {
  return sseStream(async (send) => {
    const messageId = `duffy-mock-${Date.now()}`;
    const textId = `text-${messageId}`;

    send({ type: "start", messageId });
    send({ type: "start-step" });

    await streamPlain(
      send,
      "你好這是第一次測試 我是Duffy嗎\n\n",
      { textId },
    );

    const evidence: EvidenceRef[] = [
      {
        kind: "attention",
        zone: "septic",
        metric: "hoardRatio",
        value: 9.0,
        window: 7,
      },
      {
        kind: "attention",
        zone: "writing",
        metric: "opened",
        value: 2,
        window: 7,
      },
    ];

    const userPrompt = ctx.prompt.trim() || "（無輸入）";
    const intent = await createIntent({
      kind: "observation",
      proposed_by: "duffy",
      rationale:
        "Septic 區 hoardRatio 9.0（一週囤 18 篇只開 2 篇），同期寫作區只開 2 次。注意力被筆記摘錄吸走，疑似囤積行為。",
      evidence,
      payload: {
        title: "本週注意力被筆記摘錄吸走",
        body: `針對你的「${userPrompt}」：\n\nSeptic 區這週新增 18 篇但只開 2 篇（hoardRatio 9.0），寫作區同期只開 2 次。你看起來在囤資訊而不是消化，且寫作沒推進。`,
        zone: "septic",
        window: { days: 7 },
      },
    });

    // Sentinel in its own text part — easier to scan client-side.
    const sentinelId = `text-sentinel-${messageId}`;
    send({ type: "text-start", id: sentinelId });
    send({
      type: "text-delta",
      id: sentinelId,
      delta: `<<INTENT:${intent.id}>>`,
    });
    send({ type: "text-end", id: sentinelId });

    send({ type: "finish-step" });
    send({ type: "finish" });
  });
}
