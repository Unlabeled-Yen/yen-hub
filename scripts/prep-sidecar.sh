#!/usr/bin/env bash
# Stage the Next.js standalone server for Tauri to bundle as `resources`.
# Layout after this script:
#   src-tauri/sidecar/
#     server.js
#     .next/
#     node_modules/
#     public/
#     static/        <- copied from .next/static (standalone needs it parallel)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.next/standalone"
DST="$ROOT/src-tauri/sidecar"

if [ ! -f "$SRC/server.js" ]; then
  echo "[prep-sidecar] .next/standalone/server.js missing — run pnpm build first" >&2
  exit 1
fi

rm -rf "$DST"
mkdir -p "$DST"

# Copy the standalone server tree.
cp -R "$SRC/." "$DST/"

# Next standalone expects `.next/static` and `public` alongside server.js.
mkdir -p "$DST/.next"
cp -R "$ROOT/.next/static" "$DST/.next/static"
if [ -d "$ROOT/public" ]; then
  cp -R "$ROOT/public" "$DST/public"
fi

echo "[prep-sidecar] staged $(du -sh "$DST" | cut -f1) into src-tauri/sidecar/"
