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

**On macOS, give Podman's VM at least 4 GiB (8 is better).** Every sandbox, verification run and image build shares it, and Podman's 2 GiB default cuts workers' commands off with `Aborted`. Create it with `podman machine init --memory 8192`, or resize an existing one with `nomarmy sandbox --memory 8`. `nomarmy doctor` checks it. Windows uses WSL2 memory as described below.

`install.sh` builds llama.cpp when you run a local model, installs a pinned [OpenClaw](https://github.com/openclaw/openclaw) release from npm (the host-side broker every model call goes through; set `NOMARMY_OPENCLAW_VERSION` to choose another) and configures it, builds the sandbox image, and registers the MCP server if Claude Code is installed. `nomarmy connect` (run by `install.sh`, or by hand for Codex and Cursor) also installs the `/feature` command, Claude Code's status line and, on macOS, nomArmy's notifier. The coordinator gets nomArmy's instructions from the MCP server itself, so there's nothing to copy into your projects.

**From npm or a clone:** `npm install -g nomarmy@alpha` (or `git clone` and `npm install && npm link`) gives you the `nomarmy` command, and `nomarmy setup` does the rest. `nomarmy install` runs the bundled `install.sh` for the profile setup chose; the per-platform guides below show the same steps by hand.

**Updating:** `nomarmy update` installs the latest alpha (or pulls, in a clone) and reconnects Claude Code, Codex and Cursor. Then restart every open coordinator session: each one runs the copy of nomArmy it started with. Until you do, `army` and `local_worker_capacity` tell that session to restart, and `nomarmy health` flags any coordinator still running an older copy.

### Per-repository registration

`nomarmy connect claude` registers nomArmy for every project you open. To have it only where you want it:

| | Registers nomArmy | Where |
|---|---|---|
| `nomarmy connect claude --scope local` | for this repository, only you | Claude Code's local config; `/feature` in `.claude/commands`, kept out of git |
| `nomarmy connect claude --scope project` | for this repository, for everyone who clones it | a committed `.mcp.json` that runs `nomarmy mcp`, plus `/feature` in `.claude/commands` |
| `nomarmy connect cursor --scope local\|project` | the same for Cursor | the repository's `.cursor/mcp.json` |

Run it inside the repository. A committed registration can't carry your install path or your model settings, so it runs `nomarmy mcp`, which starts nomArmy with each person's own: every teammate needs nomArmy installed and set up. Codex registers servers only for every project, so it has no per-repository option. If nomArmy is also registered for all your projects, `connect` says so; `claude mcp remove nomarmy-local-worker -s user` removes that. `nomarmy update` keeps per-repository registrations current without adding a user-wide one.

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

Windows is supported with a native front end and the nomArmy engine inside a WSL2 Linux distro. The MCP server, sandboxes and Podman run in WSL. Podman on Windows already uses a WSL2 VM, so this does not add another VM. Keeping the engine there also avoids slow job file access across the Windows and VM boundary.

1. Open an administrator PowerShell and install WSL, then restart Windows:
   ```powershell
   wsl --install
   ```
2. Install a distro if WSL did not install one. Open it once to create your Linux user:
   ```powershell
   wsl --install -d Ubuntu
   ```
3. Inside the distro, install Podman and Git, then Node 24.16 or newer. For example, on Ubuntu with nvm:
   ```bash
   sudo apt update && sudo apt install -y podman git
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
   # Reopen the distro shell after installing nvm.
   nvm install 24
   ```
   Podman runs natively inside the distro, so there is no `podman machine` to create on Windows.
4. With Node 24.16 or newer installed on Windows too, install the front end in Windows PowerShell and allow long Git paths:
   ```powershell
   npm install -g nomarmy@alpha
   git config --global core.longpaths true
   ```
5. From your project in Windows, run setup:
   ```powershell
   nomarmy setup
   ```
   Setup checks WSL, chooses a distro, checks for Node 24.16 or newer inside it, and offers to run `npm install -g nomarmy@alpha` there. It then runs the normal setup inside WSL: where models run, agents, and `nomarmy install` (OpenClaw and the sandbox image, built with the distro's Podman). nomArmy inside WSL uses only the distro's own tools, so a Windows install of nomArmy or OpenClaw doesn't stand in for it.
6. Register each coordinator you use. For example:
   ```powershell
   nomarmy connect claude
   nomarmy connect codex
   nomarmy connect cursor
   ```
   Restart the coordinator afterward. Registration starts nomArmy in WSL with absolute Node and script paths, without a shell (`wsl.exe -d <distro> --exec <node> <nomarmy.mjs> mcp`). It passes the project folder through `WSLENV`, which translates a path such as `C:\src\app` to `/mnt/c/src/app`. Per-repository registration with `--scope local` or `--scope project` is not supported on Windows yet.

Commands such as `nomarmy stats`, `nomarmy jobs` and `nomarmy update` run inside the selected distro from the translated project folder. `nomarmy doctor` checks WSL, the distro's WSL version, nomArmy inside it and the repository location. It then runs the normal engine checks inside WSL.

A repository on a Windows drive works. Jobs are much faster when the repository is inside WSL, for example at `~/src`. Open that repository from Windows as `\\wsl.localhost\<distro>\src`.

WSL2 uses about half of the computer's RAM by default. Raise its memory limit in `%UserProfile%\.wslconfig` when local models or concurrent jobs need more.

For a local model, run llama.cpp inside WSL with NVIDIA GPU passthrough. You can instead run llama.cpp natively on Windows as a shared model server. WSL2's default NAT networking gives WSL its own loopback, so `127.0.0.1` inside WSL does not reach Windows. Use either of these approaches:

* Turn on mirrored networking by adding this to `%UserProfile%\.wslconfig`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  Then apply the change in PowerShell and point setup at loopback:
  ```powershell
  wsl --shutdown
  nomarmy setup --llama-url http://127.0.0.1:8080
  ```
* With the default NAT networking, find the Windows host address from inside the distro:
  ```bash
  ip route show default | awk '{print $3}'
  ```
  Start llama-server on Windows with `--host 0.0.0.0`, and allow it through Windows Firewall for private networks. Then run this in Windows PowerShell, replacing `<address>` with the address reported above:
  ```powershell
  nomarmy setup --llama-url http://<address>:8080
  ```

The Windows front end passes `--llama-url` through to setup inside WSL.

### Windows troubleshooting

| Setup or doctor message | Fix |
|---|---|
| `WSL isn't installed.` | In an administrator PowerShell run `wsl --install`, restart Windows, then run `nomarmy setup` again. |
| `Install a Linux distro` or `No WSL distro chosen.` | Run `wsl --install -d Ubuntu`, open it once to create your user, then run `nomarmy setup` again. If several distros are installed, run `wsl --set-default <distro>`. Docker Desktop's, Rancher Desktop's and Podman machine's own distros don't count, even when one is the WSL default. |
| `choose a default WSL 2 distro` | Run `wsl --set-default <distro>`, then run `nomarmy setup` or `nomarmy connect` again. |
| `<distro> uses WSL 1.` | Run `wsl --set-version <distro> 2`. |
| `Install Node 24 (24.16+) inside <distro>` | In that distro, install nvm with the command above, reopen its shell, run `nvm install 24`, then run `nomarmy setup` again. |
| `nomArmy wasn't found in <distro>.` | Inside that distro run `npm install -g nomarmy@alpha`, then run `nomarmy setup` or `nomarmy connect` again. |
| `Repository location cannot be forwarded to the chosen WSL distro.` | Use a Windows-drive repository, or open one in the selected distro through `\\wsl.localhost\<distro>\`. |
| `A Windows-drive repository works` | No fix is required. Move the repository into WSL for much faster jobs. |

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
