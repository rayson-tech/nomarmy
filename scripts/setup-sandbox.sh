#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${NOMARMY_AGENT_IMAGE:-openclaw-nomarmy-coder:bookworm}"
command -v podman >/dev/null || { echo "ERROR: podman not found"; exit 1; }
command -v openclaw >/dev/null || { echo "ERROR: openclaw not found"; exit 1; }

# Linux runs Podman rootless, directly on the host kernel -- no VM. macOS
# needs a lightweight VM (`podman machine`), the same category of thing as
# Docker Desktop but with a 2 GiB default ceiling instead of Docker Desktop's
# ~31 GiB, and no commercial licensing tier at any company size. Both calls
# are idempotent by design: an already-initialized/already-running machine
# just no-ops here, and `podman info` below is the real verification gate,
# not either exit code.
if [[ "$(uname -s)" == "Darwin" ]]; then
  podman machine init 2>/dev/null || true
  podman machine start 2>/dev/null || true
fi
podman info >/dev/null

echo "==> Building $IMAGE"
podman build -t "$IMAGE" -f "$ROOT/docker/Dockerfile" "$ROOT/docker"
echo "==> Configuring mandatory sandbox"
openclaw config set agents.defaults.sandbox.mode all
openclaw config set agents.defaults.sandbox.backend podman
openclaw config set agents.defaults.sandbox.scope session
openclaw config set agents.defaults.sandbox.workspaceAccess rw
# Still the "docker" config namespace even though the backend is podman --
# OpenClaw's schema nests both engines' image/network/readOnlyRoot settings
# under the same key.
openclaw config set agents.defaults.sandbox.docker.image "$IMAGE"
openclaw config set agents.defaults.sandbox.docker.network none
openclaw config set agents.defaults.sandbox.docker.readOnlyRoot true
openclaw config set tools.exec.host auto
openclaw config set tools.elevated.enabled false || true
openclaw sandbox recreate --all || true
echo "==> Sandbox configured"
openclaw config get agents.defaults.sandbox
