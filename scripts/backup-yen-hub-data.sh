#!/bin/bash
# Backup Yen Hub's app data — JSON stores under ~/Library/Application Support/com.yen.hub.
#
# Slice 8.7B / 11.4 SOP: run BEFORE any schema-changing slice (e.g.
# Intent.trust_tier, new IntentKind that touches the existing intents.json
# shape). Recovery = cp -r the _backup-<stamp>/ subdir contents back.
#
# Usage:  npm run backup-data
# Output: _backup-YYYY-MM-DD-HHMM/ under the app data dir.

set -euo pipefail

SRC="$HOME/Library/Application Support/com.yen.hub"
STAMP="$(date +%Y-%m-%d-%H%M)"
DEST="$SRC/_backup-$STAMP"

if [ ! -d "$SRC" ]; then
  echo "[backup] no app data dir at: $SRC"
  exit 0
fi

mkdir -p "$DEST"

# Copy JSON files only — skip nested _backup-* (no recursive backups).
shopt -s nullglob
for f in "$SRC"/*.json "$SRC"/*.key; do
  [ -e "$f" ] || continue
  cp "$f" "$DEST/"
done

count=$(ls -1 "$DEST" 2>/dev/null | wc -l | tr -d ' ')
echo "[backup] saved $count file(s) to:"
echo "         $DEST"
