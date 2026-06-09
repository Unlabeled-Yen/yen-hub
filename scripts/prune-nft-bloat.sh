#!/usr/bin/env bash
# Prune NFT (Next File Tracing) false-positive bloat from .next/standalone.
#
# Background:
# Next.js File Tracing pessimistically walks the project tree when it
# encounters dynamic FS ops (path.join with runtime args, fs.readFile with
# computed paths, etc.). Our codebase has several legitimate cases:
#   - lib/agent/duffy/external-tools.ts: read_external_file({root, path})
#     accepts a user-supplied root + relative path.
#   - lib/agent/intent-materialize.ts: resolves vault file paths from
#     approved intent payloads.
#   - lib/auth/passkeys.ts: fs.readFile/writeFile on a runtime STORE_PATH.
#
# These are real features — we can't statically pre-resolve the paths.
# NFT's response is to copy the WHOLE project root into .next/standalone/
# just in case. With src-tauri/ at the project root, that means ~10 GB of
# Rust target/ artifacts get staged into standalone every build.
#
# `outputFileTracingExcludes` in next.config.ts SHOULD catch this but
# doesn't (tested with several pattern phrasings — none worked against
# the dynamic-FS-trigger pessimism in Next 16.2.6).
#
# This script runs immediately after `next build` finishes, prunes the
# false-positive src-tauri tree, and reports what it removed. With this in
# place the bloat exists only during the `next build` step itself, not
# afterwards. The .app bundle still ends up at ~177 MB.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/.next/standalone"

if [ ! -d "$STAGE" ]; then
  # Not a standalone build — nothing to do.
  exit 0
fi

removed_total=0
for stray in src-tauri target node_modules/.cache .git; do
  victim="$STAGE/$stray"
  if [ -d "$victim" ]; then
    size=$(du -sh "$victim" 2>/dev/null | cut -f1)
    rm -rf "$victim"
    echo "[prune-nft-bloat] removed $stray ($size)"
    removed_total=$((removed_total + 1))
  fi
done

if [ $removed_total -eq 0 ]; then
  echo "[prune-nft-bloat] nothing to prune (NFT behaved this build)"
fi
