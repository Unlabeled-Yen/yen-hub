/**
 * Agent router — given the latest user message, decide whether it's addressed
 * to a registered agent (and which one) or it's a normal chat with the
 * default Claude.
 *
 * Convention (Q3 decision, 2026-06-02): the message must START with a
 * registered agent name (case-insensitive), followed by EITHER end of
 * string, whitespace/punctuation, OR a non-ASCII-alphanumeric character —
 * so `Duffy 你好`, `duffy你好`, `Duffy:你好`, `Duffy!你好` all hit, but
 * `duffyism` doesn't.
 *
 * Future agents register here. Slice 6 only ships Duffy.
 */

const REGISTRY: string[] = ["duffy"];

/** Trailing punctuation between the name and the body that we strip. */
const SEPARATOR_RE = /^[\s,，:：!！?？、。]+/;

/** Next char immediately after the matched name MUST satisfy:
 *  - end of string, OR
 *  - not an ASCII alphanumeric / underscore (Chinese, emoji, space, punct OK).
 *  Prevents `duffyism`, `duffyfoo` etc from triggering. */
function isValidBoundary(next: string | undefined): boolean {
  if (!next) return true;
  return !/[A-Za-z0-9_]/.test(next);
}

export type RouteHit = {
  agent: string;
  /** the message body after the agent name + separator is stripped */
  body: string;
};

/** Returns a hit if the text is addressed to a registered agent. */
export function routeMessage(text: string): RouteHit | null {
  const trimmed = text.trimStart();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const name of REGISTRY) {
    if (!lower.startsWith(name)) continue;
    const boundary = trimmed.charAt(name.length);
    if (!isValidBoundary(boundary)) continue;
    const tail = trimmed.slice(name.length).replace(SEPARATOR_RE, "");
    return { agent: name, body: tail };
  }
  return null;
}

export function isRegisteredAgent(name: string): boolean {
  return REGISTRY.includes(name.toLowerCase());
}
