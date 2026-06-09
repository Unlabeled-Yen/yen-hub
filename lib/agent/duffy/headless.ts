/**
 * Headless Duffy invocation — for Telegram + future background paths.
 *
 * Mirrors runDuffy (chat route) but uses `generateText` instead of
 * `streamText`. Returns the final assembled text. No UI sentinels are
 * stripped — caller decides what to do with `<<INTENT:int_xxx>>` markers
 * (Telegram path keeps them visible so Yen can spot them).
 *
 * Same model + same tools + same system prompt as the chat version, so
 * Duffy "feels" like Duffy across surfaces.
 */

import {
  generateText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import { duffyTools } from "@/lib/agent/duffy/tools";
import { DUFFY_OPERATIONAL_RULES } from "@/lib/agent/duffy/prompt";
import { loadDuffySoul } from "@/lib/agent/agents/duffy-soul";
import {
  getCurrentSilhouette,
  renderSilhouetteForPrompt,
} from "@/lib/agent/storage/silhouettes";
import { getCurrentWeekSummary } from "@/lib/agent/storage/summaries";
import { hasAnyLLMKey, pickModel } from "@/lib/ai/model";

async function composeHeadlessSystemPrompt(surface: string): Promise<string> {
  const [soul, sil, sum] = await Promise.all([
    loadDuffySoul(),
    getCurrentSilhouette(),
    getCurrentWeekSummary(),
  ]);
  const parts: string[] = [];
  parts.push(
    "# Who you are (SOUL — edited by Yen in `06 - AI Data/agents/duffy.md`)\n\n",
  );
  parts.push(soul);
  parts.push("\n\n---\n\n");
  parts.push(DUFFY_OPERATIONAL_RULES);
  parts.push("\n\n---\n\n");
  parts.push("# Surface notice\n\n");
  parts.push(
    `You are answering on the **${surface}** surface, not the main chat palette. Keep replies tight (3-6 sentences typical) — this surface has limited screen space and is often read on a phone. Avoid long markdown tables; bulleted lists are fine. Tools work the same way; if you propose an intent, sentinels render as plain text so name the intent_id verbally.`,
  );
  if (sil) {
    parts.push("\n\n---\n\n");
    parts.push(renderSilhouetteForPrompt(sil));
  }
  if (sum) {
    parts.push("\n\n---\n\n");
    parts.push(
      `# Yen's current-week summary (auto-injected, week ${sum.week})\n\n${sum.headline}\n\n${sum.pattern}`,
    );
  }
  return parts.join("");
}

export async function runDuffyHeadless(args: {
  messages: UIMessage[];
  surface: "telegram" | string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!hasAnyLLMKey()) {
    return { ok: false, error: "no llm key configured" };
  }
  try {
    const system = await composeHeadlessSystemPrompt(args.surface);
    const result = await generateText({
      model: pickModel(),
      system,
      messages: await convertToModelMessages(args.messages),
      tools: duffyTools,
      stopWhen: stepCountIs(5),
    });
    return { ok: true, text: result.text };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
