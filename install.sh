#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib.sh"
PROFILE=""
WITH_CLAUDE=1
while [[ $# -gt 0 ]]; do case "$1" in --profile) PROFILE="$2"; shift 2;; --no-claude) WITH_CLAUDE=0; shift;; *) echo "Unknown arg: $1"; exit 2;; esac; done
load_profile "$PROFILE"
echo "==> nomArmy install ($NOMARMY_PROFILE)"
OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin)
    need brew || { echo 'ERROR: Homebrew is required on macOS. Install it from https://brew.sh, then rerun.'; exit 1; }
    command -v curl >/dev/null 2>&1 || brew install curl
    command -v git >/dev/null 2>&1 || brew install git
    command -v node >/dev/null 2>&1 || brew install node
    if nomarmy_manages_model_server; then
      command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1 || { echo 'ERROR: Xcode Command Line Tools are required. Run: xcode-select --install'; exit 1; }
      command -v cmake >/dev/null 2>&1 || brew install cmake
    fi
    # A Homebrew formula, not a cask -- installs headlessly like curl/git/node,
    # no manual first-launch the way Docker Desktop needs.
    command -v podman >/dev/null 2>&1 || brew install podman
    ;;
  Linux)
    if ! nomarmy_manages_model_server; then
      # No model is built or served here, so the C++ toolchain is not needed.
      need curl; need git; need node; need npm
    else
      if ! command -v cmake >/dev/null 2>&1 || ! command -v c++ >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then install_build_dependencies; fi
      need curl; need git; need cmake; need c++; need node; need npm
      if [[ "$NOMARMY_PROFILE" == dgx-spark || "$NOMARMY_PROFILE" == nvidia-linux ]]; then need nvidia-smi; need nvcc; fi
    fi
    # Podman runs rootless, directly on the host kernel here -- no daemon to
    # enable or start, unlike Docker Engine.
    command -v podman >/dev/null 2>&1 || install_podman
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    cat >&2 <<'MSG'
ERROR: install.sh does not run natively on Windows. Three options, and the usual
advice is not always the better one:

  1. WSL2, then run the Linux install inside your distro (supported path)
     Podman runs natively inside the WSL2 distro itself -- nothing to install
     on the Windows host, and no Docker Desktop licensing exposure there.
     Note: WSL2 defaults to ~50% of host RAM, shared across every distro. On
     a 32 GB machine that caps the model at ~16 GB. Raise it in
     %UserProfile%\.wslconfig, which needs `wsl --shutdown` and will restart
     every running container.

  2. Native Windows llama.cpp built from source, then point nomArmy at it.
     Gets the full host RAM. Needs a C++ toolchain:
       winget install Microsoft.VisualStudio.2022.BuildTools --override \
         "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
     Prebuilt llama.cpp Windows binaries are NOT a reliable shortcut: on some
     CPUs every compute backend crashes at startup (access violation) while
     non-compute binaries run fine. The cause is dynamic backend loading, so
     build it statically instead -- these flags are verified working:
       cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
         -DGGML_BACKEND_DL=OFF -DBUILD_SHARED_LIBS=OFF \
         -DGGML_NATIVE=ON -DLLAMA_CURL=OFF
     GGML_BACKEND_DL=OFF is the one that matters: it links the CPU backend in
     rather than probing for it at runtime.

  3. Run workers on a Bedrock profile and skip local inference entirely:
       ./install.sh --profile bedrock

Run `nomarmy sizing` on the host first -- it reports which of these your
hardware can actually support before you commit to one.
MSG
    exit 1
    ;;
  *)
    echo "ERROR: $OS_NAME is not a supported host. See the README for supported platforms." >&2
    exit 1
    ;;
esac
need node; need npm

# The nomarmy CLI and the MCP server both import from lib/, which has real
# dependencies. Without this a fresh clone cannot run `nomarmy` at all -- the
# first import of `yaml` fails. This is separate from the copy the worker setup
# scripts install into $NOMARMY_AGENT_INSTALL_DIR.
echo '==> Installing nomArmy dependencies'
(cd "$ROOT" && npm install --omit=dev --no-audit --no-fund)

# Put `nomarmy` on PATH. Non-fatal by design: linking needs a writable npm
# global prefix, and the CLI is equally usable as `node bin/nomarmy.mjs`.
if (cd "$ROOT" && npm link >/dev/null 2>&1); then
  echo '==> Linked the nomarmy CLI onto PATH'
else
  echo 'NOTE: could not link the nomarmy CLI (npm global prefix not writable).'
  echo "      Run it directly instead: node $ROOT/bin/nomarmy.mjs <command>"
fi
# The sandbox is required on every profile, cloud included: it is what keeps
# repository content away from host credentials. Podman readiness (starting
# the macOS VM if needed) is verified later, in scripts/setup-sandbox.sh --
# on a fresh macOS install nothing has initialized that VM yet at this point.
if nomarmy_is_cloud; then need aws || { echo 'ERROR: the AWS CLI is required for cloud profiles.'; exit 1; }; fi
"$ROOT/scripts/install-llama-cpp.sh" "$NOMARMY_PROFILE"
if ! command -v openclaw >/dev/null 2>&1; then
  echo '==> Installing OpenClaw (non-interactive)'
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
fi
need openclaw
if nomarmy_has_local_model; then openclaw plugins install @openclaw/llama-cpp-provider || true; fi
"$ROOT/scripts/start-inference.sh" "$NOMARMY_PROFILE"
# Sandbox before provider config: configure-openclaw.sh refuses to store a real
# Bedrock credential unless the coder sandbox is already network-isolated.
"$ROOT/scripts/setup-sandbox.sh"
"$ROOT/scripts/configure-openclaw.sh" "$NOMARMY_PROFILE"
if [[ "$WITH_CLAUDE" == 1 ]]; then
  if command -v claude >/dev/null 2>&1; then node "$ROOT/bin/nomarmy.mjs" connect claude; else echo 'NOTE: Claude Code not found; worker stack installed. Install Claude Code then run: nomarmy connect claude'; fi
fi
if command -v codex >/dev/null 2>&1; then node "$ROOT/bin/nomarmy.mjs" connect codex; else echo 'NOTE: Codex not found; run: nomarmy connect codex (after installing Codex)'; fi
"$ROOT/scripts/verify-install.sh" "$NOMARMY_PROFILE"
if nomarmy_is_cloud && [[ "${NOMARMY_ORCHESTRATOR_RUNTIME:-}" == "claude-code" ]]; then
  echo
  echo "==> Next: point the orchestrator at Bedrock"
  echo "    ./scripts/configure-orchestrator.sh $NOMARMY_PROFILE          # print the settings"
  echo "    ./scripts/configure-orchestrator.sh $NOMARMY_PROFILE --apply  # write them to Claude Code"
fi
if [[ "$(nomarmy_execution_mode)" == hosted ]]; then
  echo "==> Install complete. Add an agent (nomarmy agents add), give roles to it (nomarmy army init --agent <name>), then run: nomarmy doctor"
else
  echo "==> Install complete. Run: ./e2e.sh --profile $NOMARMY_PROFILE"
fi
