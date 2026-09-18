#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"

PROFILE=""; APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -h|--help) echo "Usage: $0 [profile] [--apply]"; exit 0 ;;
    *) PROFILE="$1"; shift ;;
  esac
done
load_profile "$PROFILE"

RUNTIME="${NOMARMY_ORCHESTRATOR_RUNTIME:-claude-code}"

if ! nomarmy_is_cloud; then
  echo "Profile '$NOMARMY_PROFILE' runs a local worker stack and does not configure the orchestrator."
  echo "The orchestrator is whichever Claude Code or Codex session drives the nomarmy-local-worker MCP server."
  exit 0
fi

if [[ "$RUNTIME" != "claude-code" ]]; then
  cat <<MSG
Profile '$NOMARMY_PROFILE' declares orchestrator runtime '$RUNTIME', not claude-code.

Claude Code's Bedrock integration only routes Anthropic models, so it cannot run
'$NOMARMY_ORCHESTRATOR_MODEL'. This profile's coordinator is OpenClaw driving the
same nomarmy-local-worker MCP server, configured by scripts/configure-openclaw.sh.

Orchestrator trust: ${NOMARMY_ORCHESTRATOR_TRUST:-frontier}
MSG
  exit 0
fi

SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

read -r -d '' ENV_JSON <<JSON || true
{
  "CLAUDE_CODE_USE_BEDROCK": "1",
  "AWS_REGION": "$NOMARMY_BEDROCK_REGION",
  "ANTHROPIC_MODEL": "$NOMARMY_ORCHESTRATOR_MODEL"
}
JSON

if [[ "$APPLY" -eq 0 ]]; then
  cat <<MSG
Orchestrator settings for profile '$NOMARMY_PROFILE':

  export CLAUDE_CODE_USE_BEDROCK=1
  export AWS_REGION=$NOMARMY_BEDROCK_REGION
  export ANTHROPIC_MODEL=$NOMARMY_ORCHESTRATOR_MODEL

Or write them into $SETTINGS with:

  $0 $NOMARMY_PROFILE --apply

Prompt caching is supported on Bedrock and is the single biggest lever on
coordinator spend. Leave it on; add ENABLE_PROMPT_CACHING_1H=1 only if you have
measured that the 5-minute TTL is expiring between turns, since the 1h TTL bills
at a higher rate. If cache token counts stay at zero, check that your region
supports prompt caching for this model.

Note: the WebSearch tool is unavailable when Claude Code runs on Bedrock.
MSG
  exit 0
fi

need jq || { echo 'ERROR: jq is required for --apply.' >&2; exit 1; }
mkdir -p "$(dirname "$SETTINGS")"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

BACKUP="$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
cp "$SETTINGS" "$BACKUP"

TMP="$(mktemp)"
# Merge into the existing env block rather than replacing it, so unrelated
# settings the user already relies on survive.
jq --argjson add "$ENV_JSON" '.env = ((.env // {}) + $add)' "$SETTINGS" > "$TMP"
mv "$TMP" "$SETTINGS"

echo "==> Wrote orchestrator settings to $SETTINGS (backup: $BACKUP)"
jq '.env' "$SETTINGS"
echo "==> Restart Claude Code, then run /status to confirm the provider and region."
