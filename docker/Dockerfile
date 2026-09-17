FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq python3 python3-pip python3-venv ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 sandbox 2>/dev/null || true \
    && useradd -m -u 1000 -g 1000 -s /bin/bash sandbox 2>/dev/null || true
USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
