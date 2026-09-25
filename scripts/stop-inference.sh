#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"; load_profile "${1:-}"
if ! nomarmy_manages_model_server; then
  case "$(nomarmy_execution_mode)" in
    remote) echo "Profile '$NOMARMY_PROFILE' uses the model server at $NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT; nothing local to stop." ;;
    hosted) echo "Profile '$NOMARMY_PROFILE' runs every job on an api or subscription agent; nothing local to stop." ;;
    *) echo "Profile '$NOMARMY_PROFILE' uses hosted inference at ${NOMARMY_BEDROCK_BASE_URL:-Bedrock}; nothing local to stop." ;;
  esac
  exit 0
fi
PID="$NOMARMY_INSTALL_ROOT/run/llama.pid"; if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then kill "$(cat "$PID")"; fi; rm -f "$PID"; echo stopped
