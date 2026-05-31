#!/usr/bin/env bash
# Download the bundled Node.js binary used as the Tauri sidecar.
# Idempotent — skips if the binary is already present.
# Add new triples here when shipping multi-platform.
set -euo pipefail

NODE_VER="v22.22.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"
mkdir -p "$BIN_DIR"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TRIPLE="aarch64-apple-darwin"; ARCHIVE="node-${NODE_VER}-darwin-arm64" ;;
  Darwin-x86_64) TRIPLE="x86_64-apple-darwin"; ARCHIVE="node-${NODE_VER}-darwin-x64" ;;
  *) echo "fetch-node-sidecar: unsupported host $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

DEST="$BIN_DIR/node-${TRIPLE}"
if [ -x "$DEST" ]; then
  echo "[fetch-node-sidecar] $DEST already present"
  exit 0
fi

echo "[fetch-node-sidecar] downloading Node ${NODE_VER} for ${TRIPLE}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${ARCHIVE}.tar.gz" | tar -xzf - -C "$TMP"
cp "$TMP/${ARCHIVE}/bin/node" "$DEST"
chmod +x "$DEST"
echo "[fetch-node-sidecar] ready: $DEST"
