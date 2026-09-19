#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"; load_profile "${1:-}"
if nomarmy_is_cloud; then echo "Profile '$NOMARMY_PROFILE' uses hosted inference at $NOMARMY_BEDROCK_BASE_URL; no local llama-server to start."; exit 0; fi
mkdir -p "$NOMARMY_INSTALL_ROOT/run" "$NOMARMY_INSTALL_ROOT/logs"
PID="$NOMARMY_INSTALL_ROOT/run/llama.pid"; LOG="$NOMARMY_INSTALL_ROOT/logs/llama-server.log"
if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then echo "llama-server already running PID $(cat "$PID")"; exit 0; fi
BIN="$NOMARMY_INSTALL_ROOT/llama-server"; [[ -x "$BIN" ]] || { echo "ERROR: $BIN missing"; exit 1; }
nohup "$BIN" -hf "$NOMARMY_MODEL_REPO:$NOMARMY_MODEL_QUANT" --alias "$NOMARMY_MODEL_ALIAS" --host "$NOMARMY_LLAMA_HOST" --port "$NOMARMY_LLAMA_PORT" -c "$NOMARMY_LLAMA_CONTEXT" -np "$NOMARMY_LLAMA_PARALLEL" -ngl "$NOMARMY_LLAMA_GPU_LAYERS" -t "$NOMARMY_LLAMA_THREADS" --metrics >"$LOG" 2>&1 &
echo $! > "$PID"
echo "Started llama-server PID $(cat "$PID"); first model download/load may take time. Log: $LOG"
for i in $(seq 1 180); do curl -fsS "http://$NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT/health" >/dev/null 2>&1 && { echo 'Inference healthy'; exit 0; }; sleep 2; done
echo "ERROR: inference did not become healthy; tail $LOG"; tail -80 "$LOG"; exit 1
