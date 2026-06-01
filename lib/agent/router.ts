/**
 * Agent router — given the latest user message, decide whether it's addressed
 * to a registered agent (and which one) or it's a normal chat with the
 * default Claude.
 *
 * Convention (Q3 decision, 2026-06-02): the FIRST token of the user message
 * — case-insensitive — is matched against the registry. If it matches a
 * registered agent name, the rest of the message is the prompt to that
 * agent.
 *
 * Future agents register here. Slice 6 only ships Duffy.
 */

const REGISTRY = new Set<string>(["duffy"]);

export type RouteHit = {
  agent: string;
  /** the message body after the agent name is stripped */
  body: string;
};

/** Returns a hit if the text is addressed to a registered agent. */
export function routeMessage(text: string): RouteHit | null {
  const trimmed = text.trimStart();
  if (!trimmed) return null;

  // Grab first whitespace-bounded token.
  const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  const [, headRaw, rest] = match;
  // Strip punctuation a Yen-typist might add: "Duffy,", "Duffy:", "Duffy:"
  const head = headRaw.replace(/[,，:：!！?？]+$/u, "").toLowerCase();
  if (!REGISTRY.has(head)) return null;
  return { agent: head, body: rest };
}

export function isRegisteredAgent(name: string): boolean {
  return REGISTRY.has(name.toLowerCase());
}
