FROM node:26-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq python3 python3-pip python3-venv ripgrep \
    && rm -rf /var/lib/apt/lists/*
# node:24-bookworm-slim already ships a non-root "node" user at uid/gid 1000,
# the same uid this Dockerfile used to try to create a "sandbox" user at.
# useradd silently failed on every build (masked by `|| true`), so `USER
# sandbox` below referred to a user that was never actually created --
# `docker run` for any command failed with "unable to find user sandbox: no
# matching entries in passwd file." Use the user the base image already
# provides instead of colliding with it.
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
