#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"
PROFILE=""
WITH_CLAUDE=1
while [[ $# -gt 0 ]]; do case "$1" in --profile) PROFILE="$2"; shift 2;; --no-claude) WITH_CLAUDE=0; shift;; *) echo "Unknown arg: $1"; exit 2;; esac; done
load_profile "$PROFILE"
echo "==> nomArmy Local Agents v1.2 portable install ($NOMARMY_PROFILE)"
OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin)
    need brew || { echo 'ERROR: Homebrew is required on macOS. Install it from https://brew.sh, then rerun.'; exit 1; }
    command -v curl >/dev/null 2>&1 || brew install curl
    command -v git >/dev/null 2>&1 || brew install git
    command -v node >/dev/null 2>&1 || brew install node
    if ! nomarmy_is_cloud; then
      command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1 || { echo 'ERROR: Xcode Command Line Tools are required. Run: xcode-select --install'; exit 1; }
      command -v cmake >/dev/null 2>&1 || brew install cmake
    fi
    command -v docker >/dev/null 2>&1 || { echo 'ERROR: Docker Desktop is required on macOS. Install and start it, then rerun.'; exit 1; }
    ;;
  Linux)
    if nomarmy_is_cloud; then
      # No local model is built or served, so the C++ toolchain is not needed.
      need curl; need git; need node; need npm
    else
      if ! command -v cmake >/dev/null 2>&1 || ! command -v c++ >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then install_build_dependencies; fi
      need curl; need git; need cmake; need c++; need node; need npm
      if [[ "$NOMARMY_PROFILE" == dgx-spark || "$NOMARMY_PROFILE" == nvidia-linux ]]; then need nvidia-smi; need nvcc; fi
    fi
    command -v docker >/dev/null 2>&1 || { echo 'ERROR: Docker Engine (or Docker Desktop with the WSL2 backend) is required. Install and start it, then rerun.'; exit 1; }
    ;;
  *)
    echo "ERROR: $OS_NAME is not supported directly. On Windows, use WSL2 with Docker Desktop's WSL integration." >&2
    exit 1
    ;;
esac
need node; need npm
# The sandbox is required on every profile, cloud included: it is what keeps
# repository content away from host credentials.
docker info >/dev/null || { echo 'ERROR: Docker daemon is not running.'; exit 1; }
if nomarmy_is_cloud; then need aws || { echo 'ERROR: the AWS CLI is required for cloud profiles.'; exit 1; }; fi
"$ROOT/scripts/install-llama-cpp.sh" "$NOMARMY_PROFILE"
if ! command -v openclaw >/dev/null 2>&1; then
  echo '==> Installing OpenClaw (non-interactive)'
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
fi
need openclaw
if ! nomarmy_is_cloud; then openclaw plugins install @openclaw/llama-cpp-provider || true; fi
"$ROOT/scripts/start-inference.sh" "$NOMARMY_PROFILE"
# Sandbox before provider config: configure-openclaw.sh refuses to store a real
# Bedrock credential unless the coder sandbox is already network-isolated.
"$ROOT/scripts/setup-sandbox.sh"
"$ROOT/scripts/configure-openclaw.sh" "$NOMARMY_PROFILE"
if [[ "$WITH_CLAUDE" == 1 ]]; then
  if command -v claude >/dev/null 2>&1; then "$ROOT/scripts/setup-claude-worker.sh"; else echo 'NOTE: Claude Code not found; worker stack installed. Install Claude Code then run scripts/setup-claude-worker.sh.'; fi
fi
if command -v codex >/dev/null 2>&1; then "$ROOT/scripts/setup-codex-worker.sh"; else echo 'NOTE: Codex not found; run scripts/setup-codex-worker.sh after installing Codex.'; fi
"$ROOT/scripts/verify-install.sh" "$NOMARMY_PROFILE"
if nomarmy_is_cloud && [[ "${NOMARMY_ORCHESTRATOR_RUNTIME:-}" == "claude-code" ]]; then
  echo
  echo "==> Next: point the orchestrator at Bedrock"
  echo "    ./scripts/configure-orchestrator.sh $NOMARMY_PROFILE          # print the settings"
  echo "    ./scripts/configure-orchestrator.sh $NOMARMY_PROFILE --apply  # write them to Claude Code"
fi
echo "==> Install complete. Run: ./e2e.sh --profile $NOMARMY_PROFILE"
