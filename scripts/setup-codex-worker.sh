#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${NOMARMY_AGENT_INSTALL_DIR:-$HOME/.local/share/nomarmy-local-worker}"
SERVER_NAME="nomarmy-local-worker"

for c in node npm openclaw codex git; do
  command -v "$c" >/dev/null || { echo "ERROR: $c not found"; exit 1; }
done

echo "==> Installing nomArmy local worker MCP server"
mkdir -p "$INSTALL_DIR/mcp"
cp "$ROOT/package.json" "$INSTALL_DIR/package.json"
cp "$ROOT/mcp/server.mjs" "$INSTALL_DIR/mcp/server.mjs"
# server.mjs resolves its verification runner via "../lib/verify.mjs", relative
# to its own location, so lib/ must ship as a sibling of the mcp/ directory
# (and both as children of INSTALL_DIR, so npm's node_modules resolves from
# either one by walking up).
rm -rf "$INSTALL_DIR/lib"
cp -R "$ROOT/lib" "$INSTALL_DIR/lib"

cd "$INSTALL_DIR"
npm install --omit=dev
node --check mcp/server.mjs

echo "==> Registering $SERVER_NAME with Codex"
# Best-effort removal of old name for clean upgrades.
codex mcp remove rayson-local-worker >/dev/null 2>&1 || true
codex mcp remove "$SERVER_NAME" >/dev/null 2>&1 || true
codex mcp add "$SERVER_NAME" -- node "$INSTALL_DIR/mcp/server.mjs"

echo "==> Verifying Codex MCP registration"
codex mcp list
echo "==> Installed nomArmy local worker for Codex"
