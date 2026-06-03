import { NextResponse } from "next/server";
import { type UIMessage } from "ai";
import { runDuffy } from "@/lib/agent/duffy/agent";
import { routeMessage } from "@/lib/agent/router";
import { hasAnyLLMKey } from "@/lib/ai/model";
import { getSession } from "@/lib/auth/session";

export const maxDuration = 60;

/**
 * Chat — Duffy by default.
 *
 * Routing:
 *   - If the latest user message starts with a registered agent name
 *     (`duffy`, future `tradeagent`, etc.), the message is routed to THAT
 *     agent with the name stripped from the prompt body.
 *   - **Otherwise (no prefix)**, the message ALSO goes to Duffy. He is the
 *     front desk; the user shouldn't need to say "duffy" every turn for
 *     his personality to show up.
 *
 * The previous generic "anonymous Claude" fallback was removed 2026-06-02
 * after Yen reported "Duffy feels cold like a generic front desk when I
 * don't address him by name" — because in that case the generic system
 * prompt was running, not Duffy with SOUL.
 */

export async function POST(req: Request) {
  // Auth gate
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  if (!hasAnyLLMKey()) {
    return NextResponse.json(
      {
        error:
          "no llm key configured — set KIMI_API_KEY or ANTHROPIC_API_KEY in the env, then restart dev/app.",
      },
      { status: 500 },
    );
  }

  const { messages }: { messages: UIMessage[] } = await req.json();

  // Slice 7.7: client passes its conversation id so runDuffy can mirror
  // the response into the inflight store. Header is optional — if absent,
  // we just don't track inflight (e.g. cron / one-off calls).
  const conversationId = req.headers.get("x-conversation-id") || undefined;

  // ── Agent routing ───────────────────────────────────────────────────────
  // If the latest user message addresses a registered agent (first token =
  // "Duffy", etc.), route to that agent. Otherwise default to Duffy.
  const lastUserText = extractLastUserText(messages);
  const route = lastUserText ? routeMessage(lastUserText) : null;

  // Explicit addressing — strip the name, use the rest as the prompt.
  if (route?.agent === "duffy") {
    return runDuffy({
      prompt: route.body,
      messages,
      conversationId,
    });
  }

  // Default — Duffy gets the full message as-is. He's the front desk.
  return runDuffy({ prompt: lastUserText, messages, conversationId });
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
