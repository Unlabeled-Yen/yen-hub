"use client";

/**
 * SilhouetteView — middle block of Page B.
 *
 * Renders the 5-field silhouette (OpenClaw SOUL.md format). If no silhouette
 * exists yet, shows a bootstrap CTA — clicking it calls /api/bootstrap-silhouette
 * which proposes a v1 intent (Yen approves through the chat palette).
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { tokenFetch } from "@/lib/security/sidecar-token";
import type { Silhouette } from "@/lib/agent/storage/types";

type State =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "loaded"; silhouette: Silhouette }
  | { kind: "error"; message: string };

const FIELDS: Array<{
  key: "identity" | "style" | "values" | "boundaries" | "priorities";
  label: string;
}> = [
  { key: "identity", label: "Identity" },
  { key: "style", label: "Style" },
  { key: "values", label: "Values" },
  { key: "boundaries", label: "Boundaries" },
  { key: "priorities", label: "Priorities" },
];

export function SilhouetteView() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/silhouette");
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        setState({ kind: "error", message: j.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as { silhouette: Silhouette | null };
      setState(
        data.silhouette
          ? { kind: "loaded", silhouette: data.silhouette }
          : { kind: "empty" },
      );
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const triggerBootstrap = async () => {
    setBootstrapping(true);
    setBootstrapMessage(null);
    try {
      const res = await tokenFetch("/api/silhouette/bootstrap", {
        method: "POST",
      });
      const j = (await res.json()) as {
        ok?: boolean;
        intent_id?: string;
        error?: string;
      };
      if (j.ok) {
        setBootstrapMessage(
          `已草擬第一版剪影。請打開 chat (按空白)，找最新訊息按 Yes 核准。`,
        );
      } else {
        setBootstrapMessage(`失敗：${j.error ?? "unknown"}`);
      }
    } catch (e) {
      setBootstrapMessage(`失敗：${e instanceof Error ? e.message : String(e)}`);
    }
    setBootstrapping(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
      className="rounded-2xl p-6 pointer-events-auto"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--warn)]">
          Duffy 對你的剪影
        </div>
        {state.kind === "loaded" && (
          <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
            v{state.silhouette.version} · confidence {state.silhouette.confidence}
          </div>
        )}
      </div>

      {state.kind === "loading" && (
        <div className="text-[14px] text-[var(--fg-3)]">loading…</div>
      )}

      {state.kind === "error" && (
        <div className="text-[12px] text-[var(--danger)]">
          silhouette error: {state.message}
        </div>
      )}

      {state.kind === "empty" && (
        <div className="space-y-4">
          <div className="text-[14px] leading-relaxed text-[var(--fg-1)]">
            Duffy 還沒對你建立剪影。讓他從你既有的 observations 跟 vault 看看，
            草擬第一版？你會收到一張審核卡片，按 Yes 才會落地。
          </div>
          <button
            type="button"
            onClick={triggerBootstrap}
            disabled={bootstrapping}
            className="px-4 py-2 text-[11px] font-mono tracking-[0.24em] uppercase rounded transition-opacity disabled:opacity-40"
            style={{
              background: "rgba(0,229,180,0.10)",
              border: "1px solid var(--accent)",
              color: "var(--accent)",
            }}
          >
            {bootstrapping ? "草擬中…" : "讓 Duffy 草擬 v1"}
          </button>
          {bootstrapMessage && (
            <div className="text-[12px] text-[var(--fg-2)]">
              {bootstrapMessage}
            </div>
          )}
        </div>
      )}

      {state.kind === "loaded" && (
        <div className="space-y-4">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <div className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-2)] mb-1">
                {f.label}
              </div>
              <div className="text-[14px] leading-relaxed text-[var(--fg-1)] whitespace-pre-wrap">
                {state.silhouette[f.key] || (
                  <span className="text-[var(--fg-3)]">
                    _(Duffy 還沒寫這部分)_
                  </span>
                )}
              </div>
            </div>
          ))}
          <SyncFromVaultButton onSynced={() => void load()} />
          <div className="mt-2 text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
            updated {new Date(state.silhouette.created_at).toLocaleString("zh-TW")}
            {" · "}
            reason: {state.silhouette.reason}
          </div>
        </div>
      )}
    </motion.div>
  );
}

/** Sync button — only shown when a silhouette already exists. Lets Yen tell
 *  Duffy "I edited yen.md manually in Obsidian; pick it up". */
function SyncFromVaultButton({ onSynced }: { onSynced: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const sync = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await tokenFetch("/api/silhouette/sync-from-vault", {
        method: "POST",
      });
      const j = (await res.json()) as {
        ok?: boolean;
        status?: "no-file" | "no-change" | "updated";
        version?: number;
        reason?: string;
        error?: string;
      };
      if (!j.ok) {
        setMessage(`失敗：${j.error ?? "unknown"}`);
      } else if (j.status === "no-file") {
        setMessage("vault 內沒有 yen.md");
      } else if (j.status === "no-change") {
        setMessage(`沒有變化（${j.reason ?? "identical"}）`);
      } else if (j.status === "updated") {
        setMessage(`已同步,現在是 v${j.version}`);
        onSynced();
      }
    } catch (e) {
      setMessage(`失敗：${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(false);
  };

  return (
    <div className="pt-4 border-t border-[rgba(255,255,255,0.06)] flex items-center gap-3">
      <button
        type="button"
        onClick={sync}
        disabled={busy}
        className="px-3 py-1.5 text-[10px] font-mono tracking-[0.24em] uppercase rounded transition-opacity disabled:opacity-40"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.10)",
          color: "var(--fg-2)",
        }}
        title="如果你在 Obsidian 直接編輯了 yen.md,按這個讓 Duffy 看到新版"
      >
        {busy ? "同步中…" : "↻ 從 vault 同步"}
      </button>
      {message && (
        <span className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
          {message}
        </span>
      )}
    </div>
  );
}
