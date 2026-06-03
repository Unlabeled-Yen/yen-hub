"use client";

/**
 * SoulView — bottom block of Page B, shows Duffy's SOUL (Yen's writing about
 * Duffy's identity / style / values / boundaries / priorities).
 *
 * Read-only here. Editing happens in Obsidian (the file is at
 * `06 - AI Data/agents/duffy.md`). Duffy reads the file fresh on every chat
 * turn, so edits take effect immediately on the next message — no sync
 * button needed.
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";

const SECTION_NAMES = [
  { key: "identity", label: "Identity" },
  { key: "style", label: "Style" },
  { key: "values", label: "Values" },
  { key: "boundaries", label: "Boundaries" },
  { key: "priorities", label: "Priorities" },
] as const;

type SoulMeta = {
  version?: number;
  updated_at?: string;
  confidence?: string;
};

type ParsedSoul = {
  meta: SoulMeta;
  sections: Record<string, string>;
};

function parseSoul(raw: string): ParsedSoul {
  const meta: SoulMeta = {};
  const sections: Record<string, string> = {};

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const body = fmMatch ? fmMatch[2] : raw;
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim();
      if (key === "version") meta.version = Number(val);
      else if (key === "updated_at") meta.updated_at = val;
      else if (key === "confidence") meta.confidence = val;
    }
  }

  const re = /^#\s+(\w+)\s*\r?\n([\s\S]*?)(?=\r?\n#\s+\w+|\r?\n---|\s*$)/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase();
    sections[k] = m[2].replace(/^\s*---[\s\S]*$/m, "").trim();
  }

  return { meta, sections };
}

type State =
  | { kind: "loading" }
  | { kind: "missing"; error: string; hint?: string }
  | { kind: "loaded"; parsed: ParsedSoul; mtimeMs: number; path: string };

export function SoulView() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/agents/duffy/soul");
      const j = (await res.json()) as {
        ok?: boolean;
        path?: string;
        mtimeMs?: number;
        content?: string;
        error?: string;
        hint?: string;
      };
      if (!j.ok || !j.content) {
        setState({
          kind: "missing",
          error: j.error ?? `HTTP ${res.status}`,
          hint: j.hint,
        });
        return;
      }
      setState({
        kind: "loaded",
        parsed: parseSoul(j.content),
        mtimeMs: j.mtimeMs ?? 0,
        path: j.path ?? "06 - AI Data/agents/duffy.md",
      });
    } catch (e) {
      setState({
        kind: "missing",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut", delay: 0.3 }}
      className="rounded-2xl p-6 pointer-events-auto"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--warn)]">
          Duffy 的 SOUL
        </div>
        {state.kind === "loaded" && (
          <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
            {state.parsed.meta.version != null
              ? `v${state.parsed.meta.version} · `
              : ""}
            {state.parsed.meta.confidence ?? ""}
            {state.parsed.meta.updated_at
              ? ` · ${state.parsed.meta.updated_at}`
              : ""}
          </div>
        )}
      </div>

      {state.kind === "loading" && (
        <div className="text-[14px] text-[var(--fg-3)]">loading…</div>
      )}

      {state.kind === "missing" && (
        <div className="space-y-2">
          <div className="text-[12px] text-[var(--danger)]">
            找不到 SOUL 檔：{state.error}
          </div>
          {state.hint && (
            <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
              {state.hint}
            </div>
          )}
        </div>
      )}

      {state.kind === "loaded" && (
        <div className="space-y-4">
          {SECTION_NAMES.map((s) => (
            <div key={s.key}>
              <div className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] mb-1">
                {s.label}
              </div>
              <div className="text-[14px] leading-relaxed text-[var(--fg-1)] whitespace-pre-wrap">
                {state.parsed.sections[s.key] || (
                  <span className="text-[var(--fg-3)]">
                    _(這欄還沒寫)_
                  </span>
                )}
              </div>
            </div>
          ))}
          <div className="mt-2 text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
            edit in Obsidian: {state.path} · 改完下次對話自動生效
          </div>
        </div>
      )}
    </motion.div>
  );
}
