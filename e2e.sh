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

# Under $HOME, not the system tmpdir: Podman Machine on macOS only allows
# bind-mounting paths under the host home directory, and the cleanup step
# below bind-mounts this directory into a container.
TMP="$(mktemp -d "$HOME/.nomarmy-e2e.XXXXXX")"
# OpenClaw's own state for this run, also under $HOME, the way nomArmy's
# real dispatch keeps it (--state-dir). Left unset, OpenClaw puts its
# working files in the system temp folder, which the Podman sandbox can't
# mount on macOS, and it uses the operator's main state, whose memory index
# holds their past sessions.
STATE="$(mktemp -d "$HOME/.nomarmy-e2e-state.XXXXXX")"

cleanup() {
  local exit_code=$?

  # OpenClaw leaves this run's sandbox container running; its name carries
  # the hash recorded under the state dir (as nomArmy's job cleanup does).
  if [[ -n "${STATE:-}" && -d "$STATE/state/sandbox/skills-workspaces" ]] && command -v podman >/dev/null 2>&1; then
    for ws in "$STATE"/state/sandbox/skills-workspaces/workspace-*; do
      [[ -d "$ws" ]] || continue
      podman ps -a --filter "name=${ws##*/workspace-}" --format '{{.Names}}' 2>/dev/null \
        | xargs -r podman rm -f -v >/dev/null 2>&1 || true
    done
  fi

  for dir in "${TMP:-}" "${STATE:-}"; do
  if [[ -n "$dir" && -d "$dir" ]]; then

    # OpenClaw's Podman sandbox may create files that the host user
    # cannot delete directly. Use a disposable container to clean
    # the temporary workspace first.
    if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
      podman run --rm \
        -v "$dir:/cleanup" \
        alpine:3.20 \
        sh -c '
          find /cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + \
            2>/dev/null || true
        ' \
        >/dev/null 2>&1 || true
    fi

    rm -rf "$dir" 2>/dev/null || true

    if [[ -d "$dir" ]]; then
      echo "WARN: E2E temporary directory could not be completely removed:"
      echo "      $dir"
    fi
  fi
  done

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

cd "$TMP"

git init -q
git config user.email e2e@nomarmy.local
git config user.name "nomArmy E2E"

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

# The same privacy settings every nomArmy job gets (lib/openclaw-run.mjs
# withJobPrivacy): OpenClaw's memory search and session-memory hook off, so
# nothing is indexed or sent for embedding.
CONFIG="$STATE/openclaw.job.json"
mkdir -p "$STATE/state"
node --input-type=module -e '
  import fs from "node:fs";
  import { readOpenclawConfig } from "'"$ROOT"'/lib/openclaw-config.mjs";
  import { withJobPrivacy } from "'"$ROOT"'/lib/openclaw-run.mjs";
  fs.writeFileSync(process.argv[1], JSON.stringify(withJobPrivacy(readOpenclawConfig() ?? {})), { mode: 0o600 });
' "$CONFIG"

openclaw agent exec "$PROMPT" \
  --model "$NOMARMY_WORKER_PROVIDER/$NOMARMY_WORKER_MODEL" \
  --cwd "$TMP" \
  --state-dir "$STATE/state" \
  --config "$CONFIG" \
  --code-mode direct \
  --local-model-lean \
  --thinking off \
  --timeout 600 \
  --json \
  > "$OUT" 2> "$STATE/openclaw.stderr.log"

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