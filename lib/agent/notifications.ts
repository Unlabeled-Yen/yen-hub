/**
 * macOS notifications — 方向 2 收尾.
 *
 * Surface Duffy-side events outside the .app window. Right now two
 * call sites fire notifications:
 *   - reminder schedule action (Slice 11.1)
 *   - stale-intention nudge cron (Slice 8)
 *
 * Implementation: shell out to `osascript -e 'display notification ...'`.
 * No Tauri Rust changes needed — node child_process is enough. Failure
 * silently swallowed (notifications are nice-to-have, not load-bearing).
 *
 * Opt-in: gated by trust-config.notifications_enabled. Default off so
 * upgrade doesn't silently add OS-level surface area.
 */

import { execFile } from "node:child_process";
import { getTrustConfig } from "@/lib/agent/storage/trust-config";

const APP_TITLE = "Duffy";

function escapeForAppleScript(s: string): string {
  // AppleScript strings escape " and \ with a leading backslash.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function sendMacosNotification(args: {
  title: string;
  body: string;
  subtitle?: string;
}): Promise<{ ok: boolean; error?: string }> {
  return new Promise((res) => {
    const title = escapeForAppleScript(args.title);
    const body = escapeForAppleScript(args.body);
    const subtitle = args.subtitle
      ? `with title "${title}" subtitle "${escapeForAppleScript(args.subtitle)}"`
      : `with title "${title}"`;
    const script = `display notification "${body}" ${subtitle} sound name "Glass"`;
    execFile(
      "osascript",
      ["-e", script],
      { timeout: 5000 },
      (err) => {
        if (err) {
          res({ ok: false, error: err.message });
        } else {
          res({ ok: true });
        }
      },
    );
    void APP_TITLE;
  });
}

/** Best-effort: check config, send if enabled, swallow errors. Use this
 *  from scheduler / cron paths so callers don't need to import config. */
export async function maybeNotify(args: {
  title: string;
  body: string;
  subtitle?: string;
}): Promise<void> {
  try {
    const cfg = await getTrustConfig();
    if (!cfg.notifications_enabled) return;
    await sendMacosNotification(args);
  } catch {
    /* silent — notifications never block the main flow */
  }
}
