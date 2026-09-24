#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"; load_profile "${1:-}"
fail=0
check(){ if "$@" >/dev/null 2>&1; then echo "PASS $*"; else echo "FAIL $*"; fail=1; fi; }

check git --version; check podman info; check openclaw --version

if nomarmy_is_cloud; then
  echo "INFO cloud profile '$NOMARMY_PROFILE' (region $NOMARMY_BEDROCK_REGION): no local inference expected"
  check aws --version
  if [[ -n "${NOMARMY_BEDROCK_API_KEY:-${AWS_BEARER_TOKEN_BEDROCK:-}}" ]]; then
    echo 'PASS Bedrock API key present in environment'
  else
    check aws sts get-caller-identity --region "$NOMARMY_BEDROCK_REGION"
  fi
  # Catch a model ID that is wrong or not enabled in this account/region here,
  # rather than as an opaque failure in the middle of a worker job.
  for model in "$NOMARMY_WORKER_MODEL" "$NOMARMY_WORKER_MODEL_FALLBACK"; do
    if aws bedrock list-foundation-models --region "$NOMARMY_BEDROCK_REGION" \
         --query 'modelSummaries[].modelId' --output text 2>/dev/null | grep -qF "$model"; then
      echo "PASS Bedrock model available: $model"
    else
      echo "FAIL Bedrock model not listed in $NOMARMY_BEDROCK_REGION: $model"; fail=1
    fi
  done
else
  check "$NOMARMY_INSTALL_ROOT/llama-server" --version
  if [[ "$(uname -s)" == Darwin ]]; then
    system_profiler SPDisplaysDataType 2>/dev/null | grep -qi 'Metal' && echo 'PASS Apple Metal detected' || echo 'WARN Metal detection inconclusive'
  elif [[ "$NOMARMY_PROFILE" == dgx-spark || "$NOMARMY_PROFILE" == nvidia-linux ]]; then
    check nvidia-smi
  else
    echo 'PASS CPU-only Linux profile'
  fi
  check curl -fsS "http://$NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT/health"
fi

openclaw models list --provider "$NOMARMY_WORKER_PROVIDER" | grep -q "$NOMARMY_WORKER_MODEL" \
  && echo "PASS OpenClaw worker model ($NOMARMY_WORKER_PROVIDER/$NOMARMY_WORKER_MODEL)" \
  || { echo "FAIL OpenClaw worker model ($NOMARMY_WORKER_PROVIDER/$NOMARMY_WORKER_MODEL)"; fail=1; }
# The sandbox config keeps its "docker" sub-key namespace regardless of
# backend, so grepping the whole block for "docker" would falsely pass even
# when the backend is podman. Check the actual backend value instead.
SANDBOX_BACKEND="$(openclaw config get agents.defaults.sandbox.backend 2>/dev/null | tr -d '[:space:]"' || true)"
[[ "$SANDBOX_BACKEND" == "podman" ]] && echo 'PASS Podman sandbox configured' || { echo "FAIL Podman sandbox (backend is '$SANDBOX_BACKEND')"; fail=1; }

# The no-network sandbox is what keeps repository content away from any
# credential the host process holds. It is a hard requirement on cloud profiles.
SANDBOX_NET="$(openclaw config get agents.defaults.sandbox.docker.network 2>/dev/null | tr -d '[:space:]"' || true)"
if [[ "$SANDBOX_NET" == "none" ]]; then
  echo 'PASS Sandbox network isolated'
elif nomarmy_is_cloud; then
  echo "FAIL Sandbox network is '$SANDBOX_NET', must be 'none' on a cloud profile"; fail=1
else
  echo "WARN Sandbox network is '$SANDBOX_NET', expected 'none'"
fi

node --check "$ROOT/mcp/server.mjs" && echo 'PASS MCP syntax'

if [[ "${NOMARMY_ORCHESTRATOR_TRUST:-frontier}" == "degraded" ]]; then
  echo "WARN Orchestrator trust is DEGRADED (${NOMARMY_ORCHESTRATOR_MODEL:-unset}): acceptance is not an independent check"
else
  echo "PASS Orchestrator trust is frontier (${NOMARMY_ORCHESTRATOR_MODEL:-local coordinator})"
fi

if command -v claude >/dev/null 2>&1; then claude mcp get nomarmy-local-worker >/dev/null 2>&1 && echo 'PASS Claude MCP registration' || echo 'WARN Claude installed but MCP not registered'; else echo 'INFO Claude Code not installed on this node'; fi
exit "$fail"
