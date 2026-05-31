"use client";

/**
 * Global keyboard shortcuts Tauri webview doesn't ship by default:
 *
 *   ⌘R     → navigate to "/" (entry page) — keeps session
 *   ⌘⇧L    → clear session AND go to entry (real lock)
 *   ⌘⇧F    → maximize-in-place (fill screen WITHOUT macOS native
 *            fullscreen, so transparency still reveals other apps
 *            behind the window). Press again to restore previous size.
 */

import { useEffect } from "react";
import { isTauri } from "@/lib/env/runtime";

// Remember pre-max size/position so we can restore on toggle.
const prev: { size?: { w: number; h: number }; pos?: { x: number; y: number } } = {};

async function toggleMaximizeInPlace() {
  if (!isTauri()) return;
  const { getCurrentWindow, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
  const { primaryMonitor } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const mon = await primaryMonitor();
  if (!mon) return;
  const scale = mon.scaleFactor;
  const screenW = mon.size.width / scale;
  const screenH = mon.size.height / scale;
  const currentSize = await win.outerSize();
  const isMaxed =
    Math.abs(currentSize.width / scale - screenW) < 4 &&
    Math.abs(currentSize.height / scale - screenH) < 4;

  if (isMaxed && prev.size && prev.pos) {
    await win.setSize(new LogicalSize(prev.size.w, prev.size.h));
    await win.setPosition(new LogicalPosition(prev.pos.x, prev.pos.y));
    return;
  }
  const pos = await win.outerPosition();
  prev.size = { w: currentSize.width / scale, h: currentSize.height / scale };
  prev.pos = { x: pos.x / scale, y: pos.y / scale };
  await win.setPosition(new LogicalPosition(0, 0));
  await win.setSize(new LogicalSize(screenW, screenH));
}

export function ReloadHotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();

      // ⌘R — go to entry (front page)
      if (k === "r" && !e.shiftKey) {
        e.preventDefault();
        window.location.href = "/";
        return;
      }
      // ⌘⇧L — lock: clear session cookie, then route hits entry
      if (k === "l" && e.shiftKey) {
        e.preventDefault();
        window.location.href = "/signout";
        return;
      }
      // ⌘⇧F — maximize-in-place (transparency-safe "fullscreen")
      if (k === "f" && e.shiftKey) {
        e.preventDefault();
        void toggleMaximizeInPlace();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
