# nomArmy

> Tiny local coders, big appetites for bounded tickets. 🍪

```text
       .-"""-.
      /  o o  \       🪙  🪙  🪙
     |    ▿    |   nom nom nom!
      \  \___/ /
       '._..._.'
```

**An agent harness where the worker's claims are never trusted, and the environment your tests actually need is declared, disposable and reproducible.**

A frontier coordinator (Claude Code, Codex) decides *what* should be built and whether the result is acceptable. A cheap worker — a *nom* — does the implementing, testing and repairing, usually on a local model running on your own machine at zero token cost. nomArmy owns everything in between: worktrees, Git, environments, verification, and the evidence that decides whether work is accepted.

Developed and maintained by Rayson Technologies.

## New to local LLMs? Read this first

A handful of terms come up constantly below. If a later section assumes you know one of these, come back here.

| Term | What it means here |
|---|---|
| **GGUF** | The file format `llama.cpp` loads a model from — one file (or a few numbered shards) per model. |
| **Quantization** (e.g. `Q4_K_M`) | A compressed version of a model's weights. Smaller quantizations use less RAM/VRAM and run faster, at some cost to output quality. `Q4_K_M` is a solid default; it's what nomArmy downloads out of the box. |
| **Context window** | The total number of tokens (roughly, chunks of text) a model can hold at once: your prompt *plus* everything it reads *plus* everything it writes, all sharing one fixed budget. It's a hard ceiling, not a soft guideline — more of one leaves less room for the others. |
| **llama.cpp / llama-server** | The open-source engine nomArmy uses to run a local GGUF model and serve it over an OpenAI-compatible HTTP API, the same API shape hosted providers use. |
| **Sandbox** | An isolated container (Podman here, not Docker) that a worker's file/shell tool calls run inside — no network, no host credentials, nothing outside the one task it was given. |
| **A "nom"** | nomArmy's own term for one worker: a job dispatched to a local (or hosted) model, running in its own disposable Git worktree. |

## Install

Pick your platform. Each path ends the same way: a passing local end-to-end test that proves inference, the sandbox, and the trust boundary all actually work together on your machine.

| Platform | Guide |
|---|---|
| macOS (Apple Silicon) | [macOS](#macos-apple-silicon) |
| Linux (with or without an NVIDIA GPU) | [Linux](#linux) |
| Windows | [Windows](#windows) |
| NVIDIA DGX Spark | [DGX Spark](#dgx-spark) |
| No GPU / don't want local inference | [Cloud (Bedrock)](#cloud-bedrock) |

Every platform needs Git and Podman; local (non-cloud) platforms also need enough memory to hold the model. `nomarmy doctor` checks a host's readiness and prints a fix for anything missing — see [The `nomarmy` CLI](#the-nomarmy-cli) below; you'll have it on PATH after the first step of any guide.

### macOS (Apple Silicon)

Prerequisites: Homebrew, Podman running (`podman machine start`), Git, internet access for the install and model download.

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile macbook-pro
./e2e.sh --profile macbook-pro
```

`install.sh` builds llama.cpp with Metal, installs and configures OpenClaw, starts the model, builds the Podman sandbox, and registers the MCP server if Claude Code is already installed. Expected end of `e2e.sh`:

```text
PASS inference health
PASS model discovery
PASS worker report contract
PASS autonomous edit + verification
=== E2E PASS ===
```

If Claude Code is installed, confirm the connection:

```bash
claude mcp get nomarmy-local-worker
```

Then copy/merge this repo's `CLAUDE.md` into a real project, start `claude` from that project, run `/mcp`, and delegate one small bounded ticket before increasing worker count.

**If `e2e.sh` says `No API key found for provider "llama-cpp"`:** OpenClaw needs an auth profile even though the local server takes no key. Rerun the config step:

```bash
./scripts/configure-openclaw.sh macbook-pro
./e2e.sh --profile macbook-pro
```

### Linux

The installer detects Ubuntu/Debian, Fedora/RHEL, openSUSE, Arch and Alpine and installs the C++ toolchain, CMake, Git, curl, Node and npm when missing. Install Podman yourself first (`apt install podman`, `dnf install podman`, `zypper install podman`, `pacman -S podman`, or `apk add podman`) — it's a deliberate prerequisite, not something the installer does for you.

**No NVIDIA GPU** — the portable fallback, smaller 16K context to match:

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile cpu-linux --no-claude
./e2e.sh --profile cpu-linux
```

**With an NVIDIA GPU** (a workstation RTX card, a GB10-class OEM box — not a DGX Spark, which has its own profile below):

```bash
./install.sh --profile nvidia-linux --no-claude
./e2e.sh --profile nvidia-linux
```

Copy `config/profiles/nvidia-linux.env` to a new profile file if your machine needs different context/thread/worker settings.

CPU-only Linux works but is genuinely slow for interactive use — read [Speed matters more than fit](#speed-matters-more-than-fit) before planning around it.

### Windows

`install.sh` doesn't run natively on Windows. Three real options, roughly in the order most people should try them:

1. **WSL2, with Podman installed inside the distro (the supported path).** Install a Linux distro under WSL2, install Podman *inside* it exactly as in the [Linux](#linux) guide above, then run that guide entirely inside the distro. Nothing is needed on the Windows host itself.

   Two traps: WSL2 defaults to ~50% of host RAM shared across every distro (raise it in `%UserProfile%\.wslconfig`, then `wsl --shutdown` — this restarts every running container, so do it *before* starting inference). And a repo with a deep tree can fail `git worktree add` with `Filename too long` unless you set `git config --global core.longpaths true` — `nomarmy doctor` checks for this on Windows.

2. **Native Windows llama.cpp, built from source.** Uses the full host RAM instead of WSL2's slice, at the cost of building llama.cpp yourself with a C++ toolchain. Prebuilt Windows binaries are not a safe shortcut (some CPUs crash every compute backend at startup); build statically:
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_BACKEND_DL=OFF -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=ON -DLLAMA_CURL=OFF
   ```

3. **Skip local inference and run on Bedrock:** `./install.sh --profile bedrock` — see [Cloud (Bedrock)](#cloud-bedrock).

Unsure which? Run `nomarmy sizing` first — it reports which of these your actual hardware can support.

### DGX Spark

Assumes Linux ARM64, NVIDIA drivers/CUDA, Podman, Git, internet access, and `sudo` for missing build packages.

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile dgx-spark --no-claude
./e2e.sh --profile dgx-spark
```

If you also install Claude Code on the Spark itself:

```bash
./scripts/setup-claude-worker.sh
./scripts/verify-install.sh dgx-spark
```

**Moving from a Mac install:** don't copy a Mac binary or model cache over. The repo is the deployment unit — clone fresh, select `dgx-spark`, and let `install.sh` build CUDA-native llama.cpp on that host.

### Cloud (Bedrock)

No GPU, no local build — reach for this on Windows, on underpowered hardware, or whenever you'd rather not run inference locally.

```bash
export AWS_BEARER_TOKEN_BEDROCK=...        # or configure an AWS profile
./install.sh --profile bedrock
./e2e.sh --profile bedrock
```

Enable the Anthropic and Qwen models you intend to use in the Bedrock console first. `NOMARMY_BEDROCK_REGION` (in `config/profiles/bedrock.env`) is a data-residency decision as much as a latency one.

To point the *orchestrator* (Claude Code itself) at Bedrock too:

```bash
./scripts/configure-orchestrator.sh bedrock           # print the settings
./scripts/configure-orchestrator.sh bedrock --apply   # write them to Claude Code
```

`bedrock-cheap` runs the orchestrator on the same open-weight model as the workers — real cost savings, but a materially weaker guarantee. See [How nomArmy works](#how-nomarmy-works-and-why) and `policies/reviewer.md` before using it.

## Configuration

### Where settings live

- **`config/common.env`** — defaults shared by every profile: which model, host/port, execution layer.
- **`config/profiles/<name>.env`** — per-machine overrides: context size, GPU layers, thread count, worker count. Every script in this repo loads one via `source scripts/lib.sh && load_profile <name>`.
- **A variable already exported in your shell** wins over both of the above.

Every variable is declared with an explanatory comment right next to it in `config/common.env` and whichever profile file you're using — that's the actual source of truth. The table below is an index, not a replacement for reading those two files.

### The settings you'll actually touch

| Variable | Lives in | Default | Controls |
|---|---|---|---|
| `NOMARMY_WORKER_MODEL` | common.env | `qwen3-coder-next` | Which model runs implement/scout/decompose jobs |
| `NOMARMY_MODEL_REPO` | common.env | `Qwen/Qwen3-Coder-Next-GGUF` | Hugging Face repo the GGUF is downloaded from |
| `NOMARMY_MODEL_QUANT` | common.env | `Q4_K_M` | Which quantization to download |
| `NOMARMY_LLAMA_CONTEXT` | profile | `65536` (varies by profile) | **Total** context across every inference slot |
| `NOMARMY_LLAMA_PARALLEL` | profile | `1` | Inference slots — total context is divided across these |
| `NOMARMY_MAX_WORKERS` | profile | `1` | How many jobs the coordinator runs at once |
| `NOMARMY_WORKER_MAX_TOKENS` | unset by default | 12% of context, model-scaled | Max tokens a worker may generate in a single turn before being cut off |
| `NOMARMY_EXECUTION` | common.env / profile | `local` | `local` (llama-server on this machine) or `bedrock` (hosted) |
| `NOMARMY_ORCHESTRATOR_TRUST` | common.env | `frontier` | `frontier` (coordinator outranks workers) or `degraded` (same capability class — see `policies/reviewer.md`) |

**The one coupling that trips people up:** `NOMARMY_LLAMA_CONTEXT` is divided by `NOMARMY_LLAMA_PARALLEL`, not handed to each slot whole. `65536` with `2` parallel slots gives each nom `32768`, not `65536`. Size by *context per nom* and multiply up, never the reverse. See [Sizing noms](#sizing-noms) for the full picture, and don't set `NOMARMY_MAX_WORKERS` above `NOMARMY_LLAMA_PARALLEL` on a local profile — the extra workers don't run in parallel, they queue for a slot while each still holds a Podman sandbox.

A config change needs a restart to take effect: `./scripts/stop-inference.sh && ./scripts/start-inference.sh <profile>`. Nothing here writes automatically — `nomarmy sizing`/`nomarmy scan` propose, they never provision.

### Swapping models

nomArmy runs any GGUF-format model llama.cpp can load, not only the bundled Qwen default, via llama.cpp's own Hugging Face integration:

```bash
./scripts/select-model.sh nemotron
```

This searches Hugging Face, lists the GGUF quantizations available for whatever you pick, and asks you to confirm before writing anything. To skip the search when you already know the repo:

```bash
./scripts/select-model.sh --repo nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF
```

It only updates `config/common.env`, and only after you answer `y` — nothing downloads until you restart inference:

```bash
./scripts/stop-inference.sh
./scripts/start-inference.sh macbook-pro   # or whichever profile you use
```

The model itself downloads and caches on that first start. Two things worth knowing: the target repo must actually contain GGUF files (a base-model repo with only PyTorch/safetensors weights won't run here), and a gated repo needs you to accept its license on huggingface.co and authenticate locally before the download will succeed.

## The `nomarmy` CLI

**Is there an `npm install nomarmy`?** No. The package is marked `"private": true` and is not published to the npm registry — there's nothing to `npm install -g nomarmy` from anywhere. What you get instead: clone the repo, then `npm install && npm link` inside it (the installer already does this for you as part of `install.sh`). There's also no single `nomarmy init` wizard the way some mature CLIs have one; setup is the sequence of scripts in [Install](#install) above, and the CLI itself is a small set of read-only inspection commands, not a project scaffolder.

If you only want the CLI — to size a machine or inspect a repo before committing to a full install — it stands alone:

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
npm install
npm link          # optional; puts `nomarmy` on PATH
```

Without `npm link`, every command works the same run directly: `node bin/nomarmy.mjs doctor`. `npm install` itself is not optional — the CLI imports from `lib/`, which has real dependencies (`zod`, `yaml`), so a fresh clone can't run any command until they're present.

| Command | What it does |
|---|---|
| `nomarmy doctor` | Checks this host is ready to run nomArmy and prints a fix for anything missing. Start here on any new machine. |
| `nomarmy sizing` | Recommends context/slot/worker counts from your hardware and the model's own GGUF metadata. `--check` evaluates the profile you already have instead of recommending a new one. |
| `nomarmy scan` | Reports a repository's execution environment from deterministic evidence. `--check` compares it against a committed `.nomarmy.yml`. |
| `nomarmy validate` | Validates `.nomarmy.yml` against the schema and flags any service needing explicit policy approval. |

Every command takes `--json` for machine-readable output and `--repo <dir>` to target a repository other than the current directory. None of them change anything on their own: `scan` never executes what it finds, `sizing` never writes a profile, `doctor` never installs anything. They report and propose; you decide what to apply.

## Sizing noms

Three knobs decide how many noms you get and how much room each one has, and they're coupled:

| Variable | llama.cpp flag | Meaning |
|---|---|---|
| `NOMARMY_LLAMA_CONTEXT` | `-c` | **Total** context across all slots |
| `NOMARMY_LLAMA_PARALLEL` | `-np` | Inference slots |
| `NOMARMY_MAX_WORKERS` | — | Coordinator job concurrency (noms in flight) |

`nomarmy sizing` inspects the machine (cores, RAM, VRAM, unified memory) and the model's own GGUF metadata, and recommends a combination with the memory arithmetic shown, plus the brief/report budgets a nom at that context can actually carry. It also checks memory pressure at the moment you run it — a recommendation that fits your total RAM can still refuse to admit a job right now if something else has most of it in use.

The v1.3 target is 64K context per nom: an autonomous explore/implement/test/repair loop needs more room than a one-shot edit, and a nom that runs out of context mid-repair fails the job outright, whereas one that waits for a free slot merely finishes later. Trading context for parallelism below that line is usually the wrong trade.

Raising `NOMARMY_MAX_WORKERS` is an empirical question, not a capacity one — benchmark accepted-tickets/hour and coordinator interventions before raising it; a second nom that halves the first one's context can lower total throughput.

### Speed matters more than fit

`nomarmy sizing` answers "what fits in memory?", not "is this fast enough to be useful?" — on CPU-only hardware those are very different questions.

Measured on a 20-core i7-1280P, no GPU, gpt-oss-20b (MXFP4, 11.3 GiB):

| | |
|---|---|
| Generation | ~3.8 tokens/sec |
| Prompt processing | ~6.7 tokens/sec |
| Two assistant turns on a real job | **11.5 minutes** |

A smaller model helps less than its size suggests — the harness itself (sandbox, agent loop, tool calls) costs more than the model call on CPU-only hardware. Turn count dominates over token count: every tool-call round re-reads context, so a tighter objective is worth more than a bigger context window. And provider timeouts must match the model, not a vendor default — a single slow call can exceed a hosted-inference-shaped timeout and get killed mid-turn regardless of nomArmy's own job timeout; `configure-openclaw.sh` sets both, raise them with `NOMARMY_PROVIDER_TIMEOUT_SECONDS` / `NOMARMY_AGENT_TIMEOUT_SECONDS` on slower hardware.

**Rule of thumb: GPU or a hosted profile for interactive work.** CPU-only is genuinely useful as a correctness testbed — it exercises the whole pipeline honestly — but treat it as something you're testing, not depending on.

## Starting/stopping inference

```bash
./scripts/start-inference.sh macbook-pro   # or dgx-spark, cpu-linux, nvidia-linux
./scripts/stop-inference.sh macbook-pro
```

Logs land under `$HOME/.local/share/nomarmy-local-agents/logs/`.

## Codex support

Codex reads `AGENTS.md` for repository guidance, kept alongside `CLAUDE.md` so both coordinators follow the same trust boundary and integration rules. `install.sh` registers the nomArmy MCP server for Codex automatically when the `codex` command is available; to register it later:

```bash
./scripts/setup-codex-worker.sh
codex mcp list
```

Use `/mcp` inside Codex to confirm `nomarmy-local-worker` is available.

## How nomArmy works (and why)

### The thesis

> Use scarce frontier intelligence for intent, decomposition, architecture and judgment. Use abundant worker intelligence for repository exploration, implementation, testing, repair loops and verification.

That's a hypothesis, not a claim — nomArmy exists to test it, and measures whether it holds rather than assuming it. The number that matters is **cost and wall-clock per accepted task**, plus how often a human has to step in, not tokens displaced.

### The invariant

**Worker output is a claim. Repository and environment state are evidence.**

Everything else follows from that one line. The worker never runs Git. It cannot commit, merge, or mark its own work accepted. It writes a four-line report, and nomArmy independently derives every fact that matters — what changed, what was added, whether the tests actually pass — from the repository itself. A worker that says `done` and a repository that disagrees is a failed job.

A malformed or truncated report isn't automatically a failure either: if the repository changed, nomArmy verifies independently and may recover the work. **Failing verification stays failed** — the worktree is retained, and no recovery path can launder it into an accepted job.

### Scouts and decomposers: the same invariant for reading and planning

Not every job is an edit. A **scout** is a nom that reads and never writes — it gets a question, a detached snapshot of the base commit, and no permission to modify anything. A **decomposer** is the same read-only chassis pointed at a different question: instead of "answer this," it's "propose independent pieces this objective splits into" — useful for keeping any one worker turn from having to do too much at once. Neither mode's output is trusted on its word: every claim carries a `[path:start-end]` citation, and nomArmy resolves each one against the exact commit that was read, through Git, never through the worktree — a scout or decomposer that edits its own snapshot can't forge evidence. A citation that resolves to a real file but says nothing relevant to the claim is labelled weak, and a report made only of those goes to review rather than being called complete.

**Most scout-shaped questions aren't questions for a model at all.** Where is X defined, who calls it, what does this file declare — those are deterministic, and `repo_evidence` answers them from the files in milliseconds with a citation on every hit, at zero token cost to anyone. Reach for a nom only for what that can't answer.

### What that looks like in practice

A real job, run against this repository: *add a `doctor` command to the CLI, with tests.* The worker was a 20B local model. It produced 156 lines that look like competent engineering — JSDoc throughout, pure exported check functions, a distinct remediation message per failed check.

It had six defects, every one invisible without executing it: an unterminated template literal (the file didn't parse at all), an operator-precedence bug that silently searched an empty string on Linux/macOS, executable probing that missed two of three Windows extensions, output that printed "All checks passed." unconditionally then appended "Some checks failed.", a check against an environment variable that doesn't exist in this project, and no test file despite an explicit acceptance criterion.

A reviewer skimming that diff would plausibly approve it. nomArmy committed nothing — the record showed `production files changed: 2, tests added: 0`, derived from the repository itself, not from anything the worker claimed. That's the entire argument for the design: a review process based on reading the diff fails here; one based on executing it doesn't.

## Status

nomArmy v1.2 is proven: bounded delegation, isolated worktrees, coordinator-owned Git, retained failed worktrees. v1.3 extends it toward autonomous workers with real execution environments and is still in development. Honest state of play:

| Capability | Status |
|---|---|
| Bounded delegation, coordinator-owned Git, retained worktrees | Working, E2E tested |
| Local (llama.cpp) and Amazon Bedrock execution profiles | Working |
| `nomarmy doctor` — host readiness with a fix for every failure | Working, verified on a real host |
| Scout and decompose modes — read-only noms with verified citations | Built, unit + live tested |
| `auto_union`, `verify_regression`, sandboxed independent verification | Built, unit tested |
| `.nomarmy.yml` environment contract — schema, loader, validator | Built, unit tested |
| Disposable per-job service environments (Postgres, mocks, app) | Not built |
| Nom-local browser/E2E and the autonomous repair loop | Not built |
| Full-stack acceptance test proving the thesis end to end | **Not yet run** |

Known limitations worth knowing up front: verification profiles requiring services beyond `environment: none` currently report `not_run` rather than running commands without their dependencies, and the environment scanner's Compose parser doesn't resolve YAML anchors/aliases/merge keys — affected findings are dropped with an explicit note rather than guessed at.

## The MCP tools

The coordinator drives nomArmy through the `nomarmy-local-worker` MCP server. Every job takes the same brief shape: a `task` (an objective for `implement`, a question for `scout`, a broad goal for `decompose`), optional `acceptance` items, a `mode`, and a timeout.

| Tool | What it does |
|---|---|
| `local_worker` | Run one job and wait for it. Blocks the coordinator for the duration. |
| `local_worker_start` | Start one job in the background and return a `job_id` immediately. |
| `local_worker_status` | Phase, elapsed time against the timeout, and the result once finished. `wait_seconds` long-polls; `full=true` returns the complete report. |
| `local_worker_capacity` | Context per nom, the brief/report budgets derived from it, memory pressure, and what's running. Read-only. |
| `repo_evidence` | Deterministic repository evidence with an exact `[path:line]` on every hit: definitions, references, outline, grep, files. No model, no sandbox, milliseconds. |
| `local_workers` | Run a batch with bounded parallelism and wait for all of them. `auto_union: true` mechanically merges independent implement jobs into one integration branch for review — never into your branch. |
| `local_worker_jobs` | Recent job records, including jobs still running or orphaned by a server restart. |
| `local_worker_cleanup` | Remove a retained worktree after review. Refuses to delete the current branch. |
| `local_worker_config` | Surfaces `.nomarmy.yml`'s defined verification profiles to the calling session. |

**Admission**, checked before any job starts: *context per nom bounds text* (brief/report caps come from the context one nom actually has, never a bigger prompt than it can hold), and *free memory bounds whether one more job starts at all* (a new job costs a sandbox container, never a second copy of the model — under pressure nomArmy refuses to start rather than shrinking the brief and hoping).

## Security posture

The worker gets a writable worktree inside Podman and nothing else: no Podman socket, no host credentials, no coordinator state, no arbitrary host ports, no network. Repository content is treated as untrusted input — a file in the repo cannot talk a worker into escaping its brief. Environment configuration (`.nomarmy.yml`) is data to validate, never authority: the scanner never executes anything it discovers, and verification commands run inside the sandbox or not at all, never falling back to the host.

**Never hand the general-purpose coder** AWS/production credentials, deployment access, SSH keys, Kubernetes contexts, or production Terraform state.

On cloud (Bedrock) profiles, the model call itself is made by the host-side OpenClaw process, never from inside the sandbox — the sandbox stays `network: none` regardless, and `configure-openclaw.sh` refuses to store a Bedrock credential unless that's already true. Scope the Bedrock key to `bedrock:InvokeModel` on the worker model ARNs only. What changes on a cloud profile is data flow, not sandbox reach: repository content leaves the machine, which is the decision to weigh, not the engineering.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No API key found for provider "llama-cpp"` during `e2e.sh` | `./scripts/configure-openclaw.sh <profile>`, then rerun `e2e.sh`. OpenClaw needs an auth profile even for a keyless local server. |
| `git worktree add` fails with `Filename too long` (Windows/WSL2) | `git config --global core.longpaths true`. `nomarmy doctor` checks for this. |
| A config change didn't take effect | Inference must be restarted to pick it up: `./scripts/stop-inference.sh && ./scripts/start-inference.sh <profile>`. |
| A job's verification always fails on a missing package | The coordinator's own `node_modules` can be bind-mounted read-only into the sandbox for a Node repo when the worktree's lockfile matches — see `resolveNodeModulesMount` in `lib/verify.mjs` if it isn't happening automatically. |
| Not sure a setting is right for your hardware | `nomarmy sizing` — it measures rather than guesses, and evaluates a loaded profile with `--check`. |
| General "is this host ready" question | `nomarmy doctor` — checks and proposes a fix for anything missing. |

## Files

```text
config/common.env
config/profiles/macbook-pro.env
config/profiles/dgx-spark.env
config/profiles/nvidia-linux.env
config/profiles/cpu-linux.env
config/profiles/bedrock.env
config/profiles/bedrock-cheap.env
install.sh
e2e.sh
scripts/install-llama-cpp.sh
scripts/start-inference.sh
scripts/stop-inference.sh
scripts/configure-openclaw.sh
scripts/configure-orchestrator.sh
scripts/setup-sandbox.sh
scripts/setup-claude-worker.sh
scripts/setup-codex-worker.sh
scripts/select-model.sh
scripts/verify-install.sh
mcp/server.mjs
bin/nomarmy.mjs
lib/budget.mjs        context-derived budgets, memory-pressure admission
lib/scout.mjs         scout report contract, citation verification
lib/decompose.mjs     decompose report contract, subtask overlap check
lib/repo-query.mjs    deterministic repository evidence (repo_evidence tool, scout CLI)
lib/transcript.mjs    worker transcript summary, displacement estimate
lib/sizing.mjs        hardware -> context/nom recommendation
lib/hardware.mjs  lib/gguf.mjs  lib/doctor.mjs
lib/config.mjs    lib/schema.mjs  lib/scan.mjs  lib/evidence.mjs  lib/verify.mjs
tests/
docs/experiments/     dated runbooks and results
CLAUDE.md
AGENTS.md
docker/Dockerfile
policies/coder.md  policies/scout.md  policies/orchestrator.md  policies/reviewer.md
```

## Important deployment distinction

nomArmy is portable across Mac and NVIDIA Linux **as a same-host worker/coordinator stack** — the current MCP server launches OpenClaw on the same machine the MCP runs on. A future centralized-worker release could put Claude/MCP on developer laptops while dispatching complete worker jobs to remote nodes; that remote job-control plane doesn't exist yet, and a remote llama-server alone would not be equivalent to remote sandbox/tool execution.

## Configuration naming

Configuration variables are `NOMARMY_*`. Anything still exported as `RAYSON_*` is translated once at profile load with a deprecation warning, so older installs and unit files keep working. The MCP server itself is registered as `nomarmy-local-worker`.
