/**
 * Duffy's web tools — Slice 9.
 *
 *   - web_search(query, limit?)   DuckDuckGo HTML scrape, no API key.
 *   - web_extract(url)            plain-text excerpt of a single URL.
 *
 * Both are READ-only (L0). Failure modes:
 *   - DDG rate-limits → returns empty + error string; Duffy reports to Yen.
 *   - URL fetch fails → returns ok:false; same.
 *
 * Hardening:
 *   - 10s curl timeout per request
 *   - 256KB cap on extracted HTML
 *   - Output text cap 16KB so Duffy's context doesn't balloon
 */

import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const TIMEOUT = "10";
const MAX_BYTES = 256 * 1024;
const MAX_TEXT_OUT = 16 * 1024;

async function curl(url: string): Promise<{ status: number; body: string }> {
  const { stdout } = await execFileP(
    "/usr/bin/curl",
    [
      "-sL",
      "-w",
      "\n__HTTP_STATUS__:%{http_code}",
      "-A",
      UA,
      "--max-time",
      TIMEOUT,
      url,
    ],
    { maxBuffer: MAX_BYTES * 4 },
  );
  const marker = "\n__HTTP_STATUS__:";
  const idx = stdout.lastIndexOf(marker);
  if (idx < 0) return { status: 200, body: stdout };
  return {
    status: Number(stdout.slice(idx + marker.length).trim()),
    body: stdout.slice(0, idx),
  };
}

/** Naive HTML → text. Strips tags, decodes a few common entities, collapses
 *  whitespace. Good enough for "give Duffy the gist". */
function htmlToText(html: string): string {
  // Drop <script> / <style> blocks entirely (their content is noise).
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  // Replace block-level closers with newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace.
  s = s.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ");
  return s.trim();
}

/* -------------------------------------------------------------------------- */
/*  web_search                                                                */
/* -------------------------------------------------------------------------- */

export const webSearch = tool({
  description:
    "Search the web via DuckDuckGo HTML endpoint (no API key needed). Returns up to N results with title, URL, and snippet. Use when Yen asks about current events, recent docs, or anything beyond your training cutoff. Always cite the URL(s) you used in your reply.",
  inputSchema: z.object({
    query: z.string().min(2).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  execute: async ({ query, limit }) => {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let res: { status: number; body: string };
    try {
      res = await curl(url);
    } catch (e) {
      return {
        ok: false as const,
        error: `curl failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (res.status !== 200) {
      return { ok: false as const, error: `ddg returned ${res.status}` };
    }
    // DDG result rows look roughly like:
    //   <a class="result__a" href="…">title</a> … <a class="result__snippet">…</a>
    const out: Array<{ title: string; url: string; snippet: string }> = [];
    const rowRe =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m: RegExpExecArray | null;
    const cap = limit ?? 5;
    while ((m = rowRe.exec(res.body)) !== null && out.length < cap) {
      let href = m[1];
      // DDG wraps real URLs in /l/?uddg=... Decode that.
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try {
          href = decodeURIComponent(uddg[1]);
        } catch {
          /* keep original */
        }
      }
      const title = htmlToText(m[2]).slice(0, 200);
      const snippet = htmlToText(m[3] ?? "").slice(0, 300);
      if (title && href.startsWith("http")) {
        out.push({ title, url: href, snippet });
      }
    }
    return {
      ok: true as const,
      query,
      count: out.length,
      results: out,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  web_extract                                                               */
/* -------------------------------------------------------------------------- */

export const webExtract = tool({
  description:
    "Fetch a single URL and return its main text content (HTML stripped, capped at 16KB). Use AFTER web_search picks a result you want to read in depth. NOT for paywalled / login-required pages — those will return mostly nav text.",
  inputSchema: z.object({
    url: z.string().url(),
  }),
  execute: async ({ url }) => {
    let res: { status: number; body: string };
    try {
      res = await curl(url);
    } catch (e) {
      return {
        ok: false as const,
        error: `curl failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (res.status >= 400) {
      return { ok: false as const, error: `HTTP ${res.status}` };
    }
    let text = htmlToText(res.body);
    const truncated = text.length > MAX_TEXT_OUT;
    if (truncated) text = text.slice(0, MAX_TEXT_OUT) + "\n\n[…truncated]";
    return {
      ok: true as const,
      url,
      bytes: res.body.length,
      truncated,
      text,
    };
  },
});
