/**
 * Shared LLM provider selector — used by both `/api/chat` (the plain
 * conversational route) and Duffy's agent loop. Env-driven so Yen can flip
 * providers without code edits.
 *
 *   ANTHROPIC_API_KEY → Anthropic (default if set)
 *   KIMI_API_KEY      → Moonshot's Kimi (OpenAI-compatible)
 *
 *   DUFFY_PROVIDER=anthropic|kimi   forces a specific provider
 *   DUFFY_MODEL=<model id>          overrides per-provider default
 *   KIMI_BASE_URL=<url>             default https://api.moonshot.ai/v1
 *
 * The name "Duffy" leaks into the env-var prefix because Duffy was the
 * first consumer. It applies to plain chat too — easier than introducing
 * a second prefix when there's only one selector.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

type Provider = "anthropic" | "kimi";

function resolveProvider(): Provider {
  const explicit = process.env.DUFFY_PROVIDER?.toLowerCase();
  if (explicit === "anthropic" || explicit === "kimi") return explicit;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.KIMI_API_KEY) return "kimi";
  return "anthropic"; // last-resort default; caller will fail-soft to mock
}

/** True if any provider has a usable API key. Used to flip to mock. */
export function hasAnyLLMKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY || !!process.env.KIMI_API_KEY;
}

/** Human-readable label of the currently-active model, for token-usage
 *  attribution. Returns the explicit DUFFY_MODEL when set, else the
 *  provider default. */
export function modelLabel(): string {
  const explicit = process.env.DUFFY_MODEL;
  if (explicit) return explicit;
  const provider = resolveProvider();
  return provider === "kimi" ? "kimi-latest" : "claude-sonnet-4-5";
}

/** Pick the configured LanguageModel. May return an unusable model if no
 *  key is set — callers should check `hasAnyLLMKey()` first and fall back
 *  to mock if false. */
export function pickModel(): LanguageModel {
  const provider = resolveProvider();
  if (provider === "kimi") {
    const baseURL = process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1";
    const kimi = createOpenAICompatible({
      name: "kimi",
      apiKey: process.env.KIMI_API_KEY ?? "",
      baseURL,
    });
    // `kimi-latest` is Moonshot's stable auto-routing alias; specific
    // K2 / K1.5 preview IDs come and go and gate on org permissions.
    return kimi(process.env.DUFFY_MODEL ?? "kimi-latest");
  }
  return anthropic(process.env.DUFFY_MODEL ?? "claude-sonnet-4-5");
}
