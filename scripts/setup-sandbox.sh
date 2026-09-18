#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${NOMARMY_AGENT_IMAGE:-openclaw-rayson-coder:bookworm}"
command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }
command -v openclaw >/dev/null || { echo "ERROR: openclaw not found"; exit 1; }
docker info >/dev/null
echo "==> Building $IMAGE"
docker build -t "$IMAGE" -f "$ROOT/docker/Dockerfile" "$ROOT/docker"
echo "==> Configuring mandatory sandbox"
openclaw config set agents.defaults.sandbox.mode all
openclaw config set agents.defaults.sandbox.backend docker
openclaw config set agents.defaults.sandbox.scope session
openclaw config set agents.defaults.sandbox.workspaceAccess rw
openclaw config set agents.defaults.sandbox.docker.image "$IMAGE"
openclaw config set agents.defaults.sandbox.docker.network none
openclaw config set agents.defaults.sandbox.docker.readOnlyRoot true
openclaw config set tools.exec.host auto
openclaw config set tools.elevated.enabled false || true
openclaw sandbox recreate --all || true
echo "==> Sandbox configured"
openclaw config get agents.defaults.sandbox
