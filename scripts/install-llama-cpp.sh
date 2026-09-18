#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$ROOT/scripts/lib.sh"; load_profile "${1:-}"
if nomarmy_is_cloud; then echo "Profile '$NOMARMY_PROFILE' uses hosted inference; skipping llama.cpp build."; exit 0; fi
SRC="$NOMARMY_INSTALL_ROOT/llama.cpp"; mkdir -p "$NOMARMY_INSTALL_ROOT"
if [[ ! -d "$SRC/.git" ]]; then git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$SRC"; else git -C "$SRC" pull --ff-only; fi
if [[ "$(uname -s)" == Darwin ]]; then
  cmake -S "$SRC" -B "$SRC/build" -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
elif [[ "$NOMARMY_PROFILE" == dgx-spark || "$NOMARMY_PROFILE" == nvidia-linux ]]; then
  cmake -S "$SRC" -B "$SRC/build" -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
else
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release
fi
cmake --build "$SRC/build" --config Release -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
ln -sf "$SRC/build/bin/llama-server" "$NOMARMY_INSTALL_ROOT/llama-server"
"$NOMARMY_INSTALL_ROOT/llama-server" --version || true
