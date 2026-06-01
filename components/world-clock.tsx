"use client";

/**
 * WorldClock — 固定在視窗右上角的小徽章。
 *
 * 只顯示紐約時間（24h、滾動秒數）。粗體、暖橘色、有光暈，
 * size 對齊原本「TAIPEI MON」那行 12px。
 *
 * 放在 /hub/layout.tsx 裡，所以所有 /hub/* 路由都會看到同一個徽章。
 */

import { useEffect, useState } from "react";

// 12-hour format with AM/PM — used by `format()`. We also use the parts
// API below to extract AM/PM cleanly so we can style it.
const NY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

// Date display: e.g. "FRI MAY 31" — same intelligence-agency vibe as the time.
const NY_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "2-digit",
});

function nySession(now: Date): "PRE" | "OPEN" | "AFTER" | "CLOSE" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  const wd = parts.find((p) => p.type === "weekday")?.value;
  if (wd === "Sat" || wd === "Sun") return "CLOSE";
  const mins = h * 60 + m;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "PRE";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "OPEN";
  if (mins >= 16 * 60 && mins < 20 * 60) return "AFTER";
  return "CLOSE";
}

export function WorldClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Split out AM/PM so we can style it slightly differently from the digits.
  const parts = NY_FMT.formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  const ss = parts.find((p) => p.type === "second")?.value ?? "00";
  const ampm = parts.find((p) => p.type === "dayPeriod")?.value ?? "AM";
  // NY_DATE_FMT.format() returns e.g. "Fri, May 31" — strip comma + upper.
  const dateLabel = NY_DATE_FMT.format(now).replace(",", "").toUpperCase();
  const session = nySession(now);

  return (
    <div
      className="fixed z-50 font-mono select-none pointer-events-none"
      style={{
        top: 14,
        // Aligned with the US30 panel's right edge (= page's `sm:px-12`
        // right padding, 48px from viewport).
        right: 48,
        fontSize: 12,
        letterSpacing: "0.22em",
        fontWeight: 700,
        color: "rgba(255,184,120,1)",
        textShadow:
          "0 0 6px rgba(255,184,120,0.55), 0 0 14px rgba(255,184,120,0.30)",
      }}
    >
      <span>NY</span>
      <span style={{ marginLeft: "0.6em", opacity: 0.88 }}>{dateLabel}</span>
      <span style={{ marginLeft: "0.6em" }}>
        {hh}:{mm}:{ss}
      </span>
      <span style={{ marginLeft: "0.45em", fontSize: 10, opacity: 0.85 }}>
        {ampm}
      </span>
      {/* CLOSE state is implicit (no chip when market is closed). Only show
          PRE / OPEN / AFTER — the times Yen actually needs to know. */}
      {session !== "CLOSE" ? (
        <span
          style={{
            marginLeft: "0.7em",
            opacity: 0.85,
            fontSize: 10,
          }}
        >
          {session}
        </span>
      ) : null}
    </div>
  );
}
