#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"

PROFILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg $1"
      exit 2
      ;;
  esac
done

load_profile "$PROFILE"

echo "=== nomArmy E2E: $NOMARMY_PROFILE ==="

"$ROOT/scripts/start-inference.sh" "$NOMARMY_PROFILE"

if nomarmy_is_cloud; then
  echo "INFO hosted inference at $NOMARMY_BEDROCK_BASE_URL"

  # Reachability and model entitlement are an AWS concern on this path, so the
  # provider listing stands in for the local health and discovery checks.
  openclaw models list --provider "$NOMARMY_WORKER_PROVIDER" \
    | grep -q "$NOMARMY_WORKER_MODEL"

  echo "PASS model discovery"
else
  curl -fsS \
    "http://$NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT/health" \
    >/dev/null

  echo "PASS inference health"

  MODELS="$(
    curl -fsS \
      "http://$NOMARMY_LLAMA_HOST:$NOMARMY_LLAMA_PORT/v1/models"
  )"

  echo "$MODELS" | grep -q "$NOMARMY_MODEL_ALIAS"

  echo "PASS model discovery"
fi

TMP="$(mktemp -d)"

cleanup() {
  local exit_code=$?

  if [[ -n "${TMP:-}" && -d "$TMP" ]]; then

    # OpenClaw's Docker sandbox may create files that the host user
    # cannot delete directly. Use a disposable container to clean
    # the temporary workspace first.
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      docker run --rm \
        -v "$TMP:/cleanup" \
        alpine:3.20 \
        sh -c '
          find /cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + \
            2>/dev/null || true
        ' \
        >/dev/null 2>&1 || true
    fi

    rm -rf "$TMP" 2>/dev/null || true

    if [[ -d "$TMP" ]]; then
      echo "WARN: E2E temporary directory could not be completely removed:"
      echo "      $TMP"
    fi
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

cd "$TMP"

git init -q
git config user.email e2e@rayson.local
git config user.name "Rayson E2E"

cat > calc.js <<'JS'
export function add(a,b){ return a-b; }
JS

cat > test.mjs <<'JS'
import { add } from './calc.js';

if (add(2,3)!==5) {
  console.error('FAIL');
  process.exit(1);
}

console.log('PASS');
JS

cat > package.json <<'JSON'
{
  "type": "module",
  "scripts": {
    "test": "node test.mjs"
  }
}
JSON

git add .
git commit -qm baseline

PROMPT='Fix the bug so npm test passes. Work only in the workspace. Run npm test. Do not run git. Final response MUST begin with exactly four lines: STATUS: done | partial | blocked; CHANGES: <brief>; VERIFICATION: pass | partial | failed - <brief>; NOT DONE: <list or none>.'

OUT="$TMP/openclaw.json"

openclaw agent exec "$PROMPT" \
  --model "$NOMARMY_WORKER_PROVIDER/$NOMARMY_WORKER_MODEL" \
  --cwd "$TMP" \
  --code-mode direct \
  --local-model-lean \
  --thinking off \
  --timeout 600 \
  --json \
  > "$OUT"

# Independent verification. We do not trust the worker's claim
# that its implementation is correct.
npm test

grep -Eq 'STATUS: (done|partial|blocked)' "$OUT"
echo "PASS worker report contract"

# The worker must have actually modified the implementation.
if git diff --exit-code -- calc.js >/dev/null; then
  echo "ERROR: worker made no code change"
  exit 1
fi

echo "PASS autonomous edit + verification"
echo "=== E2E PASS ==="