#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"; load_profile "${1:-}"

PROVIDER="$NOMARMY_WORKER_PROVIDER"
PROFILE_ID="$PROVIDER:nomarmy-$NOMARMY_PROFILE"

if nomarmy_is_cloud; then
  # A real, spendable credential is about to be stored. Refuse unless the coder
  # sandbox is still network-isolated, so the key cannot leave the host process
  # even if repository content tries to talk the worker into exfiltrating it.
  SANDBOX_NET="$(openclaw config get agents.defaults.sandbox.docker.network 2>/dev/null | tr -d '[:space:]"' || true)"
  if [[ -n "$SANDBOX_NET" && "$SANDBOX_NET" != "none" ]]; then
    echo "ERROR: sandbox network is '$SANDBOX_NET', expected 'none'." >&2
    echo "ERROR: refusing to store a Bedrock credential while the coder sandbox has network access." >&2
    echo "ERROR: run scripts/setup-sandbox.sh first." >&2
    exit 1
  fi

  API_KEY="${NOMARMY_BEDROCK_API_KEY:-${AWS_BEARER_TOKEN_BEDROCK:-}}"
  if [[ -z "$API_KEY" ]]; then
    echo "ERROR: cloud profile '$NOMARMY_PROFILE' needs a Bedrock credential." >&2
    echo "ERROR: export AWS_BEARER_TOKEN_BEDROCK (or NOMARMY_BEDROCK_API_KEY) and rerun." >&2
    echo "ERROR: scope it to bedrock:InvokeModel on the worker model ARNs only." >&2
    exit 1
  fi

  BASE_URL="$NOMARMY_BEDROCK_BASE_URL"
  MODEL_ID="$NOMARMY_WORKER_MODEL"
  AUTH_CHOICE="$NOMARMY_WORKER_AUTH_CHOICE"
  echo "==> Configuring OpenClaw against Bedrock ($NOMARMY_BEDROCK_REGION), model $MODEL_ID"
else
  # OpenClaw requires every provider to have an auth profile, including a
  # loopback llama.cpp server that intentionally does not require a secret.
  # The placeholder is sent only to the local server and is copied into the
  # isolated temporary agent used by e2e.sh.
  API_KEY="${NOMARMY_LOCAL_PROVIDER_API_KEY:-nomarmy-local-only}"
  BASE_URL="http://$NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT/v1"
  MODEL_ID="$NOMARMY_MODEL_ALIAS"
  AUTH_CHOICE="llama-cpp-existing-server"
  PROFILE_ID="llama-cpp:nomarmy-local"
  echo "==> Configuring OpenClaw against local llama-server, model $MODEL_ID"
fi

openclaw onboard --non-interactive --accept-risk \
  --auth-choice "$AUTH_CHOICE" \
  --custom-base-url "$BASE_URL" \
  --custom-model-id "$MODEL_ID"

printf '%s\n' "$API_KEY" | \
  openclaw models auth paste-api-key \
    --provider "$PROVIDER" \
    --profile-id "$PROFILE_ID"

if ! nomarmy_is_cloud; then
  # `openclaw onboard` cannot know a custom base URL's real context -- it has
  # no catalog entry for it -- so it registers a generic guess (observed:
  # contextWindow 24576 / contextTokens 20480 / maxTokens 4096) regardless of
  # what NOMARMY_LLAMA_CONTEXT / NOMARMY_LLAMA_PARALLEL actually say. That
  # guess then silently outlives every later context change: a job dispatched
  # against a freshly-resized 65536-token nom still overflowed at ~20K tokens
  # of prompt, on literally the first turn, because OpenClaw was still
  # enforcing its onboarding-time guess. NOMARMY_CONTEXT_PER_NOM (exported by
  # nomarmy_validate_local, above, in load_profile) is nomArmy's own already-
  # computed truth for this exact number; write it back so OpenClaw's model
  # registration cannot drift from the server it is actually talking to.
  # models[0] assumes exactly the one custom local model this script just
  # onboarded, which is what onboard --custom-model-id always produces here.
  CONTEXT_WINDOW="${NOMARMY_CONTEXT_PER_NOM:-24576}"
  # A flat 4096-token default (nomArmy's own prior default, independent of
  # openclaw's onboarding guess above) starved a worker mid-turn tonight: it
  # hit finish_reason=length while still writing its first file, with 61440
  # tokens of prompt budget sitting almost entirely unused on a 65536-context
  # nom. Scale the default with the model's own context window instead of a
  # number picked for no model in particular: 12% of it, clamped to a floor
  # that still matches the old default on a small nom and a ceiling that
  # keeps the prompt side from being starved in turn. NOMARMY_WORKER_MAX_TOKENS
  # remains the explicit override for a model that needs something else.
  DEFAULT_WORKER_MAX_TOKENS=$(( CONTEXT_WINDOW * 12 / 100 ))
  [[ "$DEFAULT_WORKER_MAX_TOKENS" -lt 4096 ]] && DEFAULT_WORKER_MAX_TOKENS=4096
  [[ "$DEFAULT_WORKER_MAX_TOKENS" -gt 16384 ]] && DEFAULT_WORKER_MAX_TOKENS=16384
  WORKER_MAX_TOKENS="${NOMARMY_WORKER_MAX_TOKENS:-$DEFAULT_WORKER_MAX_TOKENS}"
  CONTEXT_TOKENS=$(( CONTEXT_WINDOW - WORKER_MAX_TOKENS ))
  openclaw config set "models.providers.$PROVIDER.models.0.contextWindow" "$CONTEXT_WINDOW" --strict-json
  openclaw config set "models.providers.$PROVIDER.models.0.contextTokens" "$CONTEXT_TOKENS" --strict-json
  openclaw config set "models.providers.$PROVIDER.models.0.maxTokens" "$WORKER_MAX_TOKENS" --strict-json
fi

# A local model on CPU can take many minutes for a single response. OpenClaw
# times out per model call independently of nomArmy's job timeout, so a slow
# worker is killed mid-turn unless this ceiling is raised to match. nomArmy's
# whole premise is slow cheap workers, so this is not an edge case.
openclaw config set "models.providers.$PROVIDER.timeoutSeconds" "${NOMARMY_PROVIDER_TIMEOUT_SECONDS:-1800}"
openclaw config set agents.defaults.timeoutSeconds "${NOMARMY_AGENT_TIMEOUT_SECONDS:-5400}"

openclaw models list --provider "$PROVIDER"
