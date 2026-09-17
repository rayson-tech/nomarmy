#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${NOMARMY_AGENT_INSTALL_DIR:-$HOME/.local/share/rayson-local-worker}"
SERVER_NAME="rayson-local-worker"

for c in node npm openclaw codex git; do
  command -v "$c" >/dev/null || { echo "ERROR: $c not found"; exit 1; }
done

echo "==> Installing nomArmy local worker MCP server"
mkdir -p "$INSTALL_DIR"
cp "$ROOT/package.json" "$INSTALL_DIR/package.json"
cp "$ROOT/mcp/server.mjs" "$INSTALL_DIR/server.mjs"

cd "$INSTALL_DIR"
npm install --omit=dev
node --check server.mjs

echo "==> Registering $SERVER_NAME with Codex"
codex mcp remove "$SERVER_NAME" >/dev/null 2>&1 || true
codex mcp add "$SERVER_NAME" -- node "$INSTALL_DIR/server.mjs"

echo "==> Verifying Codex MCP registration"
codex mcp list
echo "==> Installed nomArmy local worker for Codex"
