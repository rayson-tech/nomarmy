FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
# Same base as docker/Dockerfile plus a Go toolchain -- the worker's own
# tool-calling harness needs Node regardless of the target repo's language.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq python3 python3-pip python3-venv ripgrep \
    && rm -rf /var/lib/apt/lists/*
# Debian bookworm's packaged golang-go lags stable Go by multiple years
# (verified live: apt installed 1.19 here while go.dev's stable was 1.27) --
# same reasoning as using rustup instead of apt for Rust in Dockerfile.rust.
# Pinned, not "latest", for a reproducible build; bump GO_VERSION by hand
# periodically against https://go.dev/dl/, with both SHA256 values from
# https://go.dev/dl/?mode=json.
ENV GO_VERSION=1.27.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
         amd64) GOARCH=amd64; SHA256=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445 ;; \
         arm64) GOARCH=arm64; SHA256=3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec ;; \
         *) echo "unsupported architecture for Go install: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" -o /tmp/go.tgz \
    && echo "${SHA256}  /tmp/go.tgz" | sha256sum -c - \
    && tar -C /usr/local -xzf /tmp/go.tgz \
    && rm /tmp/go.tgz
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH=/home/node/go
ENV PATH="${GOPATH}/bin:${PATH}"
USER node
RUN mkdir -p "${GOPATH}"
WORKDIR /workspace
CMD ["sleep", "infinity"]
