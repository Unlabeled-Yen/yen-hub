"use client";

/**
 * StudioView — the studio face fed by REAL cross-project work-state
 * (/api/studio) instead of vault mirrors. Each project card shows what the
 * old panels never did: how cold it is, what you last did (git), what's
 * uncommitted (紅燈), and the next-step / landmines from its checkpoint memory.
 *
 * Aesthetic mirrors CoachCard (dark base, cream text, --accent border).
 */

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type ProjectState = {
  name: string;
  path: string;
  lastCommit: string | null;
  daysCold: number | null;
  recentCommits: string[];
  uncommitted: number;
  checkpointName: string | null;
  checkpointExcerpt: string | null;
  error: string | null;
};

type State =
  | { kind: "loading" }
  | { kind: "loaded"; projects: ProjectState[] }
  | { kind: "error"; message: string };

export function StudioView() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await tokenFetch("/api/studio");
        if (!res.ok) {
          const j = (await res.json()) as { error?: string };
          if (alive)
            setState({
              kind: "error",
              message: j.error ?? `HTTP ${res.status}`,
            });
          return;
        }
        const data = (await res.json()) as { projects: ProjectState[] };
        if (alive) setState({ kind: "loaded", projects: data.projects });
      } catch (e) {
        if (alive)
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="font-mono text-[11px] uppercase tracking-[0.32em] text-[var(--warn)]">
          工作室 · 跨專案工作狀態
        </h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--fg-3)]">
          git + checkpoint · 即時
        </span>
      </div>

      {state.kind === "loading" && (
        <div className="text-[14px] text-[var(--fg-3)]">loading…</div>
      )}
      {state.kind === "error" && (
        <div className="text-[12px] text-[var(--danger)]">
          studio error: {state.message}
        </div>
      )}
      {state.kind === "loaded" && (
        <div className="flex flex-col gap-4">
          {state.projects.map((p, i) => (
            <ProjectCard key={p.name} p={p} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

type KnobKind = "project" | "checkpoint";

async function pullKnob(project: string, kind: KnobKind): Promise<string | null> {
  try {
    const res = await tokenFetch("/api/studio/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, kind }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return j.error ?? `HTTP ${res.status}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function Knob({
  label,
  onClick,
  busy,
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors disabled:opacity-40"
      style={{
        borderColor: "var(--accent)",
        color: "var(--fg-1)",
        background: "transparent",
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

function ProjectCard({ p, index }: { p: ProjectState; index: number }) {
  const cold = p.daysCold != null && p.daysCold > 7;
  const [busy, setBusy] = useState<KnobKind | null>(null);
  const [knobError, setKnobError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const pull = async (kind: KnobKind) => {
    setBusy(kind);
    setKnobError(null);
    const err = await pullKnob(p.name, kind);
    setBusy(null);
    if (err) setKnobError(err);
  };
  const firstCommit = p.recentCommits[0];
  const restCount = Math.max(0, p.recentCommits.length - 1);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut", delay: index * 0.05 }}
      className="rounded-2xl p-5"
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid var(--accent)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[16px] text-[var(--fg-0)]">{p.name}</span>
        {p.lastCommit && (
          <span
            className="font-mono text-[10px] uppercase tracking-[0.18em]"
            style={{ color: cold ? "var(--warn)" : "var(--fg-3)" }}
          >
            {p.daysCold === 0 ? "今天" : `冷 ${p.daysCold} 天`} · {p.lastCommit}
          </span>
        )}
        {p.uncommitted > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--danger)]">
            ● {p.uncommitted} 未提交
          </span>
        )}
        {p.error && (
          <span className="font-mono text-[10px] text-[var(--danger)]">
            err: {p.error}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Knob
            label="open ↗"
            busy={busy === "project"}
            onClick={() => void pull("project")}
          />
          {p.checkpointName && (
            <Knob
              label="memo ↗"
              busy={busy === "checkpoint"}
              onClick={() => void pull("checkpoint")}
            />
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "收合" : "展開"}
            className="ml-1 font-mono text-[12px] text-[var(--fg-3)] hover:text-[var(--fg-1)] transition-colors"
          >
            {expanded ? "▾" : "▸"}
          </button>
        </span>
      </div>
      {knobError && (
        <div className="mt-2 font-mono text-[10px] text-[var(--danger)]">
          knob error: {knobError}
        </div>
      )}

      {!expanded && (firstCommit || p.checkpointName) && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--fg-2)]">
          {firstCommit && (
            <span className="truncate">
              · {firstCommit}
              {restCount > 0 && (
                <span className="ml-1 font-mono text-[10px] text-[var(--fg-3)]">
                  +{restCount}
                </span>
              )}
            </span>
          )}
          {p.checkpointName && (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--fg-3)]">
              有 memo
            </span>
          )}
        </div>
      )}

      {expanded && p.recentCommits.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.24em] text-[var(--fg-3)]">
            做到哪
          </div>
          <ul className="space-y-0.5">
            {p.recentCommits.map((c, j) => (
              <li
                key={j}
                className="text-[13px] leading-snug text-[var(--fg-1)]"
              >
                · {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {expanded && p.checkpointExcerpt && (
        <div className="mt-3">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.24em] text-[var(--fg-3)]">
            下一步 / 雷 · {p.checkpointName}
          </div>
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--fg-1)]">
            {p.checkpointExcerpt}
          </p>
        </div>
      )}
    </motion.div>
  );
}
