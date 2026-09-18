#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INSTALL_DIR="${NOMARMY_AGENT_INSTALL_DIR:-$HOME/.local/share/nomarmy-local-worker}"
SERVER_NAME="nomarmy-local-worker"

for c in node npm openclaw claude git; do
  command -v "$c" >/dev/null || {
    echo "ERROR: $c not found"
    exit 1
  }
done

echo "==> Installing nomArmy local worker MCP server"
echo "    Install directory: $INSTALL_DIR"

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

echo "==> Installing MCP dependencies"

npm install --omit=dev

echo "==> Validating MCP server"

node --check mcp/server.mjs

echo "==> Registering $SERVER_NAME with Claude Code"

# Best-effort removal of old name for clean upgrades.
claude mcp remove rayson-local-worker --scope user >/dev/null 2>&1 || claude mcp remove rayson-local-worker >/dev/null 2>&1 || true

# Remove an older registration if one exists.
# Failure here is harmless when this is a fresh install.
claude mcp remove "$SERVER_NAME" --scope user >/dev/null 2>&1 || \
claude mcp remove "$SERVER_NAME" >/dev/null 2>&1 || \
true

# Register the installed copy rather than a path inside the
# extracted deployment package. This allows the ZIP directory
# to be deleted after installation.
if claude mcp add \
  --scope user \
  "$SERVER_NAME" \
  -- node "$INSTALL_DIR/mcp/server.mjs"
then
  :
else
  # Compatibility fallback for Claude Code versions whose MCP
  # command does not support --scope user.
  echo "NOTE: Claude Code did not accept --scope user; retrying with default scope."

  claude mcp add \
    "$SERVER_NAME" \
    -- node "$INSTALL_DIR/mcp/server.mjs"
fi

echo "==> Verifying Claude MCP registration"

if ! claude mcp get "$SERVER_NAME"; then
  echo
  echo "ERROR: Claude Code did not return the newly registered MCP server."
  echo "Check available servers with:"
  echo
  echo "  claude mcp list"
  echo
  exit 1
fi

echo
echo "==> Installed nomArmy local worker"
echo "    MCP server: $SERVER_NAME"
echo "    Server path: $INSTALL_DIR/mcp/server.mjs"
