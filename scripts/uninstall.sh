#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${NOMARMY_AGENT_INSTALL_DIR:-$HOME/.local/share/nomarmy-local-worker}"
claude mcp remove nomarmy-local-worker >/dev/null 2>&1 || true
rm -rf "$INSTALL_DIR"
echo "Removed nomarmy-local-worker MCP installation. Retained ~/.local/share/nomarmy-local-agents/jobs for recovery/audit."
