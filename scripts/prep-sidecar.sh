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

# 2026-06-09 — Next's NFT pulls src-tauri/ into .next/standalone because
# lib/auth/passkeys.ts uses `join(process.cwd(), ...)`. Strip it BEFORE
# copying so a single 10GB Rust target dir doesn't blow up the cp -R.
# next.config.ts has outputFileTracingExcludes but it doesn't catch this.
if [ -d "$SRC/src-tauri" ]; then
  echo "[prep-sidecar] pruning $SRC/src-tauri ($(du -sh "$SRC/src-tauri" | cut -f1)) before copy"
  rm -rf "$SRC/src-tauri"
fi
for stray in target node_modules/.cache .git; do
  if [ -d "$SRC/$stray" ]; then
    echo "[prep-sidecar] pruning $SRC/$stray ($(du -sh "$SRC/$stray" | cut -f1)) before copy"
    rm -rf "$SRC/$stray"
  fi
done

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

# 2026-06-09 — defensive cleanup against Next File Tracing pulling in
# src-tauri/ (Rust build artifacts). The outputFileTracingExcludes in
# next.config.ts doesn't catch dynamic-path code (child_process / homedir
# in app routes), and NFT then walks the project tree and stages the whole
# Rust target dir. Without this rm, the .app bloats from ~160MB → 10GB+.
if [ -d "$DST/src-tauri" ]; then
  echo "[prep-sidecar] pruning stray src-tauri/ ($(du -sh "$DST/src-tauri" | cut -f1))"
  rm -rf "$DST/src-tauri"
fi
# 2026-06-11 — docs/ is README-only (screenshots + architecture map). NFT
# stages it because README.md references docs/screenshots, but nothing in
# the running server reads it — pruning saves ~14MB from the .app.
if [ -d "$DST/docs" ]; then
  echo "[prep-sidecar] pruning docs/ ($(du -sh "$DST/docs" | cut -f1)) — README-only, unused at runtime"
  rm -rf "$DST/docs"
fi
# 2026-06-11 — sharp + @img/libvips (~16MB) is Next's image-optimization
# runtime. We set images.unoptimized and never use next/image, so it's never
# loaded. next.config excludes it from NFT; this is belt-and-suspenders in
# case a future build re-traces it.
for img in node_modules/sharp node_modules/@img; do
  if [ -d "$DST/$img" ]; then
    echo "[prep-sidecar] pruning $img ($(du -sh "$DST/$img" | cut -f1)) — image-opt runtime, unused"
    rm -rf "$DST/$img"
  fi
done
for stray in target node_modules/.cache .git; do
  if [ -d "$DST/$stray" ]; then
    echo "[prep-sidecar] pruning stray $stray ($(du -sh "$DST/$stray" | cut -f1))"
    rm -rf "$DST/$stray"
  fi
done

echo "[prep-sidecar] staged $(du -sh "$DST" | cut -f1) into src-tauri/sidecar/"
