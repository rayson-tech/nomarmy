#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"; load_profile "${1:-}"
if nomarmy_is_cloud; then echo "Profile '$NOMARMY_PROFILE' uses hosted inference at $NOMARMY_BEDROCK_BASE_URL; no local llama-server to start."; exit 0; fi
mkdir -p "$NOMARMY_INSTALL_ROOT/run" "$NOMARMY_INSTALL_ROOT/logs"
PID="$NOMARMY_INSTALL_ROOT/run/llama.pid"; LOG="$NOMARMY_INSTALL_ROOT/logs/llama-server.log"
if [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; then echo "llama-server already running PID $(cat "$PID")"; exit 0; fi
BIN="$NOMARMY_INSTALL_ROOT/llama-server"; [[ -x "$BIN" ]] || { echo "ERROR: $BIN missing"; exit 1; }
ARGS=(-hf "$NOMARMY_MODEL_REPO:$NOMARMY_MODEL_QUANT" --alias "$NOMARMY_MODEL_ALIAS" --host "$NOMARMY_LLAMA_HOST" --port "$NOMARMY_LLAMA_PORT" -c "$NOMARMY_LLAMA_CONTEXT" -np "$NOMARMY_LLAMA_PARALLEL" -ngl "$NOMARMY_LLAMA_GPU_LAYERS" -t "$NOMARMY_LLAMA_THREADS" --metrics)
# Everything below is optional advanced tuning, unset by default: nothing
# here changes behavior for anyone who hasn't set these. See README's
# "Advanced llama-server tuning" section for what each one is for.
[[ -n "${NOMARMY_LLAMA_CACHE_TYPE_K:-}" ]] && ARGS+=(--cache-type-k "$NOMARMY_LLAMA_CACHE_TYPE_K")
[[ -n "${NOMARMY_LLAMA_CACHE_TYPE_V:-}" ]] && ARGS+=(--cache-type-v "$NOMARMY_LLAMA_CACHE_TYPE_V")
[[ -n "${NOMARMY_LLAMA_FLASH_ATTN:-}" ]] && ARGS+=(--flash-attn "$NOMARMY_LLAMA_FLASH_ATTN")
[[ -n "${NOMARMY_LLAMA_REASONING_BUDGET:-}" ]] && ARGS+=(--reasoning-budget "$NOMARMY_LLAMA_REASONING_BUDGET")
if [[ -n "${NOMARMY_LLAMA_REASONING_PRESERVE:-}" ]]; then
  if [[ "$NOMARMY_LLAMA_REASONING_PRESERVE" == "true" ]]; then ARGS+=(--reasoning-preserve)
  else ARGS+=(--no-reasoning-preserve)
  fi
fi
# Raw escape hatch for any current or future llama-server flag this script
# does not name explicitly. Word-split intentionally; quote-embedded spaces
# are not supported, matching how every other *_EXTRA_ARGS-style env var works.
if [[ -n "${NOMARMY_LLAMA_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  EXTRA=($NOMARMY_LLAMA_EXTRA_ARGS)
  ARGS+=("${EXTRA[@]}")
fi
nohup "$BIN" "${ARGS[@]}" >"$LOG" 2>&1 &
echo $! > "$PID"
echo "Started llama-server PID $(cat "$PID"); first model download/load may take time. Log: $LOG"
became_healthy=0
for i in $(seq 1 180); do curl -fsS "http://$NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT/health" >/dev/null 2>&1 && { became_healthy=1; break; }; sleep 2; done
if [[ "$became_healthy" -ne 1 ]]; then
  echo "ERROR: inference did not become healthy; tail $LOG"; tail -80 "$LOG"; exit 1
fi
# /health only reports that a model is loaded into slots, not that the backend
# can actually compute -- a Metal/CUDA allocation failure during load (seen in
# practice: a real "Insufficient Memory" GPU error, kIOGPUCommandBufferCallbackErrorOutOfMemory)
# still leaves /health reporting fine. Do one real forward pass before calling it healthy.
if curl -fsS -m 30 -X POST "http://$NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT/completion" \
    -H "Content-Type: application/json" -d '{"prompt":"ok","n_predict":1}' >/dev/null 2>&1; then
  echo 'Inference healthy'; exit 0
fi
echo "ERROR: model loaded but a real completion request failed -- likely a GPU/compute allocation error, not a startup timing issue; tail $LOG"; tail -80 "$LOG"; exit 1
