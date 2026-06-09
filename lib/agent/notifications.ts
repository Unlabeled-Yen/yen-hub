/**
 * macOS notifications — 方向 2 收尾, 2026-06-10 重寫.
 *
 * Surface Duffy-side events outside the .app window. Call sites:
 *   - reminder schedule action (Slice 11.1)
 *   - stale-intention nudge cron (Slice 8)
 *   - manual test from NotificationsToggle (page-b 04 信任分層)
 *
 * Implementation history:
 *   v1 (─ 2026-06-09): `osascript -e 'display notification ...'` from
 *     Node child_process. Worked on signed binaries; on recent macOS
 *     (Sequoia / Tahoe) the OS silently dropped them because Yen.app is
 *     unsigned and osascript has no bundle identity to attribute the
 *     notification to. No system permission prompt ever appeared.
 *
 *   v2 (2026-06-10 — current): pipe a `[NOTIFY]{json}` line to stdout.
 *     Rust side (sidecar.rs `handle_notify_payload`) reads the existing
 *     stdout drain, parses the line, and fires via
 *     tauri-plugin-notification — which goes through Yen.app's bundle
 *     identity (com.yen.hub). First send triggers macOS's permission
 *     prompt; afterwards Yen appears in System Settings → Notifications.
 *
 * Opt-in: gated by trust-config.notifications_enabled. Default off so
 * upgrade doesn't silently add OS-level surface area.
 */

import { getTrustConfig } from "@/lib/agent/storage/trust-config";

export async function sendMacosNotification(args: {
  title: string;
  body: string;
  subtitle?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    // Single-line JSON so the Rust-side line-based stdout parser can
    // recover the full payload from one `[NOTIFY]` event. Embedded
    // newlines in body/subtitle would split the marker line, so we
    // strip them defensively — the Rust handler trims and json-parses
    // exactly one line.
    const payload = JSON.stringify({
      title: args.title.replace(/[\r\n]+/g, " "),
      body: args.body.replace(/[\r\n]+/g, " "),
      subtitle: args.subtitle?.replace(/[\r\n]+/g, " "),
    });
    // process.stdout.write is synchronous on TTY/pipes; we use it
    // directly (not console.log) so the marker is never accidentally
    // co-mingled with another log line in a chunk boundary.
    process.stdout.write(`[NOTIFY]${payload}\n`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
