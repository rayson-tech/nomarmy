# Install

`nomarmy setup` walks you through all of this: see the [TL;DR](../README.md#tldr), or the [example setup](setup/example.md) for every command. This page is the same ground by hand, per platform.

| Setup | Guide |
|---|---|
| API keys and subscriptions, no local model (most people) | [Hosted workers only](#hosted-workers-only) |
| A local model on macOS (Apple Silicon) | [macOS](#macos-apple-silicon) |
| A local model on Linux, with or without an NVIDIA GPU | [Linux](#linux) |
| Windows | [Windows](#windows) |
| NVIDIA DGX Spark | [DGX Spark](#dgx-spark) |
| A shared GPU server (or a tunnel to one) | [A shared model server](#a-shared-model-server) |
| No GPU, with Bedrock | [Cloud (Bedrock)](#cloud-bedrock) |

Every platform needs Git and Podman. `nomarmy doctor` checks the host and prints a fix for anything missing.

`install.sh` builds llama.cpp when you run a local model, installs and configures [OpenClaw](https://github.com/openclaw/openclaw) (the host-side broker every model call goes through), builds the sandbox image, and registers the MCP server if Claude Code is installed. `nomarmy connect` (run by `install.sh`, or by hand for Codex and Cursor) also installs the `/feature` command, Claude Code's status line and, on macOS, nomArmy's notifier. The coordinator gets nomArmy's instructions from the MCP server itself, so there's nothing to copy into your projects.

**From npm or a clone:** `npm install -g nomarmy@alpha` (or `git clone` and `npm install && npm link`) gives you the `nomarmy` command, and `nomarmy setup` does the rest. `nomarmy install` runs the bundled `install.sh` for the profile setup chose; the per-platform guides below show the same steps by hand.

## Hosted workers only

No GPU and no local model: every job runs on an API key or a subscription (ChatGPT, Muse Code) you add as an agent. Git worktrees, the sandbox and verification still run on your machine, so you still need Git, Node and Podman. `nomarmy setup` walks these steps for you; by hand, they are:

```bash
nomarmy setup --hosted               # records that this install has no local model
nomarmy install                      # OpenClaw, the sandbox, and the Claude Code registration; no llama.cpp
nomarmy agents add                   # an API key or a subscription login
nomarmy army init --agent <name>     # every role on that agent (add --model <model> to pick one)
nomarmy doctor
```

A hosted install refuses a job that names no role or agent, rather than falling back to a local model that isn't there. `nomarmy health` warns about any role still on `local`. `e2e.sh` tests the local model, so it has nothing to do here; `nomarmy army assign` tests each role's route instead.

## macOS (Apple Silicon)

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile macbook-pro
./e2e.sh --profile macbook-pro
```

`install.sh` builds llama.cpp with Metal, installs and configures OpenClaw, starts the model, builds the sandbox, and registers the MCP server if Claude Code is installed. `e2e.sh` should end with:

```text
PASS inference health
PASS model discovery
PASS worker report contract
PASS autonomous edit + verification
=== E2E PASS ===
```

If `e2e.sh` says `No API key found for provider "llama-cpp"`, run `./scripts/configure-openclaw.sh macbook-pro` and try again.

## Linux

`install.sh` installs the toolchain, CMake, Git and Node when they're missing. Install Podman yourself first (`apt`, `dnf`, `zypper`, `pacman` or `apk install podman`).

```bash
# no NVIDIA GPU
./install.sh --profile cpu-linux --no-claude && ./e2e.sh --profile cpu-linux

# an NVIDIA GPU (not a DGX Spark: see below)
./install.sh --profile nvidia-linux --no-claude && ./e2e.sh --profile nvidia-linux
```

CPU-only Linux works but is slow for interactive use: see [Sizing](configuration.md#sizing).

## Windows

`install.sh` doesn't run natively. In order of preference:

1. **WSL2** (the supported path): install a Linux distro under WSL2, install Podman inside it, and follow the [Linux](#linux) guide entirely inside the distro. Watch WSL2's default cap of about half your RAM (`.wslconfig`), and set `git config --global core.longpaths true` (`nomarmy doctor` checks this).
2. **Native llama.cpp on Windows**, built from source: more RAM, more setup. Prebuilt binaries aren't a safe shortcut; some CPUs crash every backend at startup.
3. **No local inference**: [hosted workers only](#hosted-workers-only), or [Bedrock](#cloud-bedrock).

`nomarmy sizing` reports what your hardware can support.

## DGX Spark

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile dgx-spark --no-claude
./e2e.sh --profile dgx-spark
```

Moving from a Mac install? Don't copy a Mac binary or model cache over: clone fresh and let `install.sh` build llama.cpp for CUDA on that machine.

## A shared model server

A team GPU box (a DGX, a workstation) runs one llama-server; everyone else points nomArmy at it. That works through an SSH tunnel too (`ssh -L 8080:localhost:8080 gpu-box`, then `http://127.0.0.1:8080`).

```bash
nomarmy setup --llama-url http://gpu-box:8080   # checks /health, records the address
nomarmy install                                 # no llama.cpp build; OpenClaw points at that server
./e2e.sh --profile remote
```

nomArmy doesn't start, stop or size that server: whoever runs it sets its model, context and slots, and `install.sh` reads the model name and context from the server. Your machine still runs the sandbox and verification for your jobs. Several people sharing one server share its slots, so keep `NOMARMY_MAX_WORKERS` low (the profile sets 1). Run the server itself with any local profile's `install.sh` on the GPU machine, with `NOMARMY_LLAMA_HOST=0.0.0.0` so others can reach it, on a network you trust: llama-server has no authentication.

## Cloud (Bedrock)

No GPU, no local build:

```bash
export AWS_BEARER_TOKEN_BEDROCK=...   # or configure an AWS profile
./install.sh --profile bedrock
./e2e.sh --profile bedrock
```

Enable the models you intend to use in the Bedrock console first. `bedrock-cheap` runs the coordinator on the same open-weight model as the workers: real savings, a materially weaker guarantee (see `policies/reviewer.md`).
