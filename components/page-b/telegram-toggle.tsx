"use client";

/**
 * TelegramToggle — sit next to NotificationsToggle in 04 信任分層.
 *
 * Three-state UI:
 *   - not configured: shows token + chat_id inputs.
 *   - configured but disabled: shows status + enable switch.
 *   - configured + enabled: shows status + disable switch + test button.
 *
 * Token is masked once stored (the server returns only a preview like
 * "12345…ABCD"). User can paste a new one to overwrite.
 */

import { useCallback, useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type Status = {
  enabled: boolean;
  has_token: boolean;
  token_preview: string | null;
  chat_id: number | null;
};

export function TelegramToggle() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/telegram/toggle");
      if (!res.ok) return;
      const data = (await res.json()) as Status;
      setStatus(data);
      if (!data.has_token) setEditing(true);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreds = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const cidNum = parseInt(chatIdInput.trim(), 10);
      if (!Number.isFinite(cidNum)) {
        setMsg("chat_id 必須是數字");
        setBusy(false);
        return;
      }
      const res = await tokenFetch("/api/telegram/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: tokenInput.trim(),
          chat_id: cidNum,
          enabled: true,
          test: true,
        }),
      });
      const data = (await res.json()) as Status & {
        test_result: { ok: boolean; error?: string } | null;
      };
      setStatus(data);
      setEditing(false);
      setTokenInput("");
      setChatIdInput("");
      if (data.test_result) {
        setMsg(
          data.test_result.ok
            ? "已發送測試訊息到你的 Telegram"
            : `測試失敗：${data.test_result.error}`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (!status || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const next = !status.enabled;
      const res = await tokenFetch("/api/telegram/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next, test: next }),
      });
      const data = (await res.json()) as Status & {
        test_result: { ok: boolean; error?: string } | null;
      };
      setStatus(data);
      if (data.test_result) {
        setMsg(
          data.test_result.ok
            ? "已發送測試訊息"
            : `測試失敗：${data.test_result.error}`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const clearCreds = async () => {
    if (busy) return;
    if (!confirm("確定清除 Telegram 設定？bot token 跟 chat_id 都會被移除。")) return;
    setBusy(true);
    try {
      const res = await tokenFetch("/api/telegram/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: null, chat_id: null, enabled: false }),
      });
      const data = (await res.json()) as Status;
      setStatus(data);
      setEditing(true);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  return (
    <div className="mt-5 pt-4 border-t border-[var(--border-subtle)]">
      <div className="flex items-center justify-between gap-4 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-[var(--fg-0)]">Telegram</div>
          <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)] mt-1 leading-relaxed">
            雙向 · Duffy reminder/醒提推到手機、你也能直接打字跟他對話。
          </div>
        </div>
        {status.has_token && (
          <button
            type="button"
            disabled={busy}
            onClick={toggleEnabled}
            aria-label={status.enabled ? "停用 Telegram" : "啟用 Telegram"}
            className="shrink-0 relative inline-flex h-[22px] w-[40px] rounded-full transition-colors disabled:opacity-40"
            style={{
              background: status.enabled ? "var(--accent)" : "rgba(255,255,255,0.10)",
              border: "1px solid rgba(255,255,255,0.10)",
            }}
          >
            <span
              className="inline-block h-[16px] w-[16px] rounded-full bg-white transition-transform"
              style={{
                transform: status.enabled ? "translateX(20px)" : "translateX(2px)",
                marginTop: "2px",
              }}
            />
          </button>
        )}
      </div>

      {/* Credentials view */}
      {status.has_token && !editing && (
        <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)] flex items-center gap-3 flex-wrap">
          <span>Token: {status.token_preview}</span>
          <span>·</span>
          <span>chat_id: {status.chat_id}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[var(--fg-2)] hover:text-[var(--fg-0)] underline"
          >
            修改
          </button>
          <button
            type="button"
            onClick={clearCreds}
            className="text-[var(--fg-3)] hover:text-[var(--warn)] underline"
          >
            清除
          </button>
        </div>
      )}

      {/* Credentials form */}
      {editing && (
        <div className="mt-2 flex flex-col gap-2">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="BotFather token (1234:ABC...)"
            className="px-3 py-2 text-[12px] font-mono rounded border bg-transparent text-[var(--fg-0)]"
            style={{ borderColor: "var(--border-subtle)" }}
          />
          <input
            type="text"
            inputMode="numeric"
            value={chatIdInput}
            onChange={(e) => setChatIdInput(e.target.value)}
            placeholder="chat_id (純數字)"
            className="px-3 py-2 text-[12px] font-mono rounded border bg-transparent text-[var(--fg-0)]"
            style={{ borderColor: "var(--border-subtle)" }}
          />
          <div className="flex justify-end gap-2">
            {status.has_token && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setTokenInput("");
                  setChatIdInput("");
                }}
                className="px-3 py-1.5 text-[10px] font-mono tracking-[0.24em] uppercase rounded border text-[var(--fg-2)]"
                style={{ borderColor: "rgba(255,255,255,0.10)" }}
              >
                取消
              </button>
            )}
            <button
              type="button"
              disabled={busy || !tokenInput.trim() || !chatIdInput.trim()}
              onClick={submitCreds}
              className="px-3 py-1.5 text-[10px] font-mono tracking-[0.24em] uppercase rounded transition-opacity disabled:opacity-40"
              style={{
                background: "rgba(0, 229, 180, 0.10)",
                border: "1px solid var(--accent)",
                color: "var(--accent)",
              }}
            >
              {busy ? "..." : "儲存 + 測試"}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <div className="mt-2 text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
          {msg}
        </div>
      )}
    </div>
  );
}
