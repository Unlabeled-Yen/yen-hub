"use client";

/**
 * NotificationsToggle — 方向 2 收尾.
 *
 * Tiny opt-in switch for OS-level notifications. Lives in 04 信任分層
 * next to Auto-pilot, since both are "let Duffy reach further into your
 * life" knobs.
 *
 * Test button: when enabling, fires one immediate notification so the
 * user can confirm macOS permission was granted (first time triggers
 * the permission prompt).
 */

import { useCallback, useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

export function NotificationsToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastTest, setLastTest] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await tokenFetch("/api/trust-config");
      if (!res.ok) return;
      const data = (await res.json()) as { notifications_enabled: boolean };
      setEnabled(data.notifications_enabled);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onToggle = async () => {
    if (enabled === null || busy) return;
    setBusy(true);
    const next = !enabled;
    try {
      const res = await tokenFetch("/api/notifications/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next, test: next }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          notifications_enabled: boolean;
          test_result: { ok: boolean; error?: string } | null;
        };
        setEnabled(data.notifications_enabled);
        if (data.test_result) {
          setLastTest(
            data.test_result.ok
              ? "已發送測試通知（如沒看到、檢查 macOS 通知權限）"
              : `測試失敗：${data.test_result.error ?? "unknown"}`,
          );
        } else {
          setLastTest(null);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) return null;

  return (
    <div className="mt-5 pt-4 border-t border-[var(--border-subtle)]">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-[var(--fg-0)]">macOS 通知</div>
          <div className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)] mt-1 leading-relaxed">
            reminder 排程 + 醒提觸發時、桌面通知會跳出來、你不在 .app 也戳得到。
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          aria-label={enabled ? "停用通知" : "啟用通知"}
          className="shrink-0 relative inline-flex h-[22px] w-[40px] rounded-full transition-colors disabled:opacity-40"
          style={{
            background: enabled ? "var(--accent)" : "rgba(255,255,255,0.10)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <span
            className="inline-block h-[16px] w-[16px] rounded-full bg-white transition-transform"
            style={{
              transform: enabled ? "translateX(20px)" : "translateX(2px)",
              marginTop: "2px",
            }}
          />
        </button>
      </div>
      {lastTest && (
        <div className="mt-2 text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--fg-3)]">
          {lastTest}
        </div>
      )}
    </div>
  );
}
