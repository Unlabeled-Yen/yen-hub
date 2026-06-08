#!/usr/bin/env bash
# Yen Hub freeze-time diagnostic capture.
#
# Run THIS while the app is currently frozen — it captures everything
# Claude needs to diagnose in one shot:
#   - last 100 lines of sidecar log
#   - process CPU/memory snapshot
#   - lightweight stack sample of the webview's WebContent process
#   - macOS "powermetrics" / activity context (best-effort)
#
# Output goes to /tmp/yen-freeze-<timestamp>.txt — send that one file
# to Claude. spindump needs sudo, so you'll be prompted for password.

set -u
ts=$(date +%Y%m%d-%H%M%S)
out="/tmp/yen-freeze-$ts.txt"

{
  echo "=== Yen Hub Freeze Diagnostic ==="
  echo "Captured: $(date)"
  echo

  echo "## 1. Last 100 lines of sidecar log"
  echo "----------------------------------"
  tail -100 ~/Library/Logs/com.yen.hub/Yen.log 2>/dev/null || echo "(no log file)"
  echo

  echo "## 2. Yen.app process tree (CPU/RSS)"
  echo "------------------------------------"
  ps aux | grep -iE "Yen\.app|app_lib|com\.yen|WebKit\.WebContent\.xpc" | grep -v grep
  echo

  echo "## 3. Webview process CPU samples (5 sec)"
  echo "-----------------------------------------"
  wpid=$(pgrep -f "WebKit\.WebContent\.xpc.*" 2>/dev/null | head -1)
  if [ -n "$wpid" ]; then
    echo "Sampling PID $wpid (5 sec)..."
    sample "$wpid" 5 -file /tmp/yen-sample-$ts.txt 2>&1 | tail -2
    echo "(full stack written to /tmp/yen-sample-$ts.txt)"
    # Append just the "Sample analysis" header lines for quick scan
    head -50 /tmp/yen-sample-$ts.txt 2>/dev/null
  else
    echo "(no WebContent process found)"
  fi
  echo

  echo "## 4. Spindump (Yen.app main process, needs sudo)"
  echo "-------------------------------------------------"
  ypid=$(pgrep -f "Yen.app/Contents/MacOS/app" 2>/dev/null | head -1)
  if [ -n "$ypid" ]; then
    sudo spindump "$ypid" 3 -file /tmp/yen-spindump-$ts.txt 2>&1 | tail -3
    echo "(full spindump at /tmp/yen-spindump-$ts.txt)"
    head -60 /tmp/yen-spindump-$ts.txt 2>/dev/null
  else
    echo "(no Yen.app process found)"
  fi
  echo

  echo "## 5. App Nap status"
  echo "--------------------"
  echo "NSAppSleepDisabled (user default):"
  defaults read com.yen.hub NSAppSleepDisabled 2>/dev/null || echo "  (not set — App Nap enabled)"
  echo

} | tee "$out"

echo
echo "=================================="
echo "Diagnostic written to: $out"
echo "Send this file to Claude."
echo "=================================="
