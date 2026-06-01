import { NextResponse } from "next/server";
import { anthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { runDuffy } from "@/lib/agent/duffy/agent";
import { routeMessage } from "@/lib/agent/router";
import { getSession } from "@/lib/auth/session";

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are Yen's personal AI assistant inside Yen Hub.

Yen is a Traditional Chinese speaker (Taiwan) who reads English fluently. Reply in Traditional Chinese by default. Switch to English only when it's the natural register for the topic (code, technical terms, English quotes).

Style:
- Direct. No filler. No "as an AI, I can't..." disclaimers.
- Brief by default. Expand only when the question demands depth.
- Never sycophantic. Don't open with "great question".
- Honest about uncertainty. Say "I don't know" or "I'm guessing" when true.
- Yen prefers conversational analysis over bullet-point lists for casual exchanges.

You don't yet have access to Yen's Vault, pipelines, or any personal data — that's coming in later slices. For now you're a conversational partner that knows Yen Hub is being built around you.`;

const MOCK_REPLIES = [
  "嗯，我聽到了 — 但 API 還沒接上，這是 mock 模式。等框架穩了再讓我真的回答。",
  "Mock 中。框架還在搭，我會在這邊假裝思考一陣子。",
  "（mock）介面流程都通了。真的對話在下一片 slice。",
  "現在我說的話都是假的 — 把這個介面當畫布測就好。",
];

function pickReply(messages: UIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text =
    lastUser?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("") ?? "";
  const idx = Math.abs(hash(text)) % MOCK_REPLIES.length;
  return MOCK_REPLIES[idx];
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function mockStream(text: string): Response {
  const encoder = new TextEncoder();
  const messageId = `mock-${Date.now()}`;
  const textId = `text-${messageId}`;
  const chunks = Array.from(text); // emit char-by-char so it feels streamed

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ type: "start", messageId });
      send({ type: "start-step" });
      send({ type: "text-start", id: textId });
      for (const ch of chunks) {
        await new Promise((r) => setTimeout(r, 28));
        send({ type: "text-delta", id: textId, delta: ch });
      }
      send({ type: "text-end", id: textId });
      send({ type: "finish-step" });
      send({ type: "finish" });
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

export async function POST(req: Request) {
  // Auth gate — parity with the rest of /api. Slice 6.5 closes this gap
  // (chat was the only /api endpoint without a session check).
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const { messages }: { messages: UIMessage[] } = await req.json();

  // Mock mode: when MOCK_AI=1 OR no API key, fake a stream.
  const mock =
    process.env.MOCK_AI === "1" || !process.env.ANTHROPIC_API_KEY;

  // ── Agent routing ───────────────────────────────────────────────────────
  // If the latest user message addresses a registered agent (first token =
  // "Duffy", etc.), route to that agent's pipeline. Otherwise fall through
  // to the default chat (a plain Claude conversation).
  const lastUserText = extractLastUserText(messages);
  const route = lastUserText ? routeMessage(lastUserText) : null;
  if (route?.agent === "duffy") {
    // runDuffy() chooses mock vs real internally based on env
    // (MOCK_AI=1 or missing ANTHROPIC_API_KEY → mock).
    return runDuffy({ prompt: route.body, messages });
  }

  if (mock) {
    return mockStream(pickReply(messages));
  }

  const result = streamText({
    model: anthropic("claude-sonnet-4-5"),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}

function extractLastUserText(messages: UIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  return (
    lastUser.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("") ?? ""
  );
}
