#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${NOMARMY_AGENT_INSTALL_DIR:-$HOME/.local/share/rayson-local-worker}"
claude mcp remove rayson-local-worker >/dev/null 2>&1 || true
rm -rf "$INSTALL_DIR"
echo "Removed rayson-local-worker MCP installation. Retained ~/.local/share/rayson-local-agents/jobs for recovery/audit."
