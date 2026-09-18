#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"; load_profile "${1:-}"
if nomarmy_is_cloud; then echo "Profile '$NOMARMY_PROFILE' uses hosted inference; nothing local to stop."; exit 0; fi
PID="$NOMARMY_INSTALL_ROOT/run/llama.pid"; if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then kill "$(cat "$PID")"; fi; rm -f "$PID"; echo stopped
