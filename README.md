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

A frontier coordinator decides *what* should be built and whether the result is acceptable. A cheap worker — a *nom* — does the implementing, testing and repairing. nomArmy owns everything in between: worktrees, Git, environments, verification, and the evidence that decides whether work is accepted.

Developed and maintained by Rayson Technologies.

## The thesis

> Use scarce frontier intelligence for intent, decomposition, architecture and judgment. Use abundant worker intelligence for repository exploration, implementation, testing, repair loops and verification.

That is a hypothesis, not a claim. nomArmy exists to test it, and the project measures whether it holds rather than assuming it. The number that matters is **cost and wall-clock per accepted task**, plus how often a human has to step in — not tokens displaced.

## The invariant

**Worker output is a claim. Repository and environment state are evidence.**

Everything else follows from that one line. The worker never runs Git. It cannot commit, merge, or mark its own work accepted. It writes a four-line report, and nomArmy independently derives every fact that matters — what changed, what was added, whether the tests actually pass — from the repository itself. A worker that says `done` and a repository that disagrees is a failed job.

A malformed or truncated report is not automatically a failure either: if the repository changed, nomArmy verifies independently and may recover the work. **Failing verification stays failed**, the worktree is retained, and no recovery path can launder it into an accepted job.

## Status

nomArmy v1.2 is proven: bounded delegation, isolated worktrees, coordinator-owned Git, retained failed worktrees. v1.3 is in development and extends it toward autonomous workers with real execution environments. Honest state of play:

| Capability | Status |
|---|---|
| Bounded delegation, coordinator-owned Git, retained worktrees | Working, E2E tested |
| Local (llama.cpp) and Amazon Bedrock execution profiles | Working |
| Objective + acceptance-criteria briefs, compact worker contract | Built, unit tested |
| Truncated-report recovery, test-change classification, metrics | Built, unit tested |
| `.nomarmy.yml` environment contract — schema, loader, validator | Built, unit tested |
| Deterministic environment scanner and evidence normalizer | Built, unit tested |
| Hardware detection and nom sizing | Built |
| Sandboxed independent verification | In progress |
| Disposable per-job service environments (Postgres, mocks, app) | Not built |
| Nom-local browser/E2E and the autonomous repair loop | Not built |
| Fresh integrated PR-gate environment | Not built |
| Full-stack acceptance test proving the thesis end to end | **Not yet run** |

"Built, unit tested" means the logic is covered by tests; it does not mean it has run against a live worker on a real ticket. The last row is the one that decides whether any of this was worth doing, and it is honestly still open.

Known limitations worth knowing up front: the Compose parser does not resolve YAML anchors, aliases or merge keys — affected findings are dropped with an explicit note rather than guessed at. Verification profiles requiring services beyond `environment: none` currently report `not_run` rather than running commands without their dependencies.

## Security posture

The worker gets a writable worktree and nothing else. No Docker socket, no host credentials, no coordinator state, no arbitrary host ports, and no unrestricted network. Repository content is untrusted input: a file in the repo cannot talk a worker into escaping its brief.

Environment configuration is **data to validate, not authority**. The scanner is deterministic and never executes anything it discovers. An LLM may later propose a `.nomarmy.yml` from bounded scan evidence, but that proposal is schema-validated and independently probed before anything runs. Verification commands execute inside the sandbox, never on the host — if the sandbox is unavailable, verification reports `not_run` rather than falling back.

## What `install.sh` provisions

`install.sh` installs/builds or configures the worker stack:

- llama.cpp from the official `ggml-org/llama.cpp` repository
- Metal build on Apple Silicon macOS
- CUDA build on NVIDIA Linux / DGX Spark class machines
- Qwen3-Coder-Next GGUF (`Q4_K_M` default), downloaded by llama.cpp from the official Qwen Hugging Face repository on first start
- an OpenAI-compatible `llama-server` with stable alias `qwen3-coder-next`
- OpenClaw when absent, plus its official llama.cpp provider plugin
- OpenClaw connection to the local llama-server
- hardened Docker coding sandbox (no network, no elevated host execution)
- on a Bedrock profile: no local build at all — workers and coordinator are hosted
- the nomArmy MCP server, registered with Claude Code when it is installed
- platform profiles, nom sizing, and E2E verification

It intentionally does **not** install or authenticate Claude Code. Claude credentials are a user/organization concern. A DGX worker can therefore be provisioned with `--no-claude`, while a machine that will run the Claude coordinator can register the MCP locally.

## Profiles

- `macbook-pro`: Apple Silicon / Metal, 32K active llama context, one inference slot, one worker.
- `dgx-spark`: NVIDIA Linux ARM64 / CUDA, 64K active llama context, two inference slots, two workers initially.
- `nvidia-linux`: generic NVIDIA Linux/CUDA, conservative 32K/one-worker defaults.
- `cpu-linux`: generic Linux without CUDA. This is the portable fallback and uses a smaller 16K context.

All values live in `config/common.env` and `config/profiles/*.env`. Hardware tuning is configuration, not coordinator code.

### Cloud profiles

- `bedrock`: workers and orchestrator both served from Amazon Bedrock. No local inference, so this profile carries no GPU or OS requirement and is the only one that runs on a machine without a GPU. Workers run `qwen.qwen3-coder-next` — the same model the local profiles run, which makes local vs hosted a clean A/B rather than a model swap. The orchestrator is Claude Opus 5, so the coordinator still outranks the workers it reviews.
- `bedrock-cheap`: same workers, but the orchestrator is the same open-weight model. **Degraded acceptance** — see `policies/reviewer.md` before using it.

Local profiles cost nothing per token and are capped by VRAM. Bedrock profiles are capped by TPM quota and budget, so `NOMARMY_MAX_WORKERS` above 1 is reachable. Measure first-pass accept rate before raising it: coordinator review tokens dominate worker tokens, so a cheaper worker that fails the gate more often is not cheaper.

Cloud profiles send repository content off the machine. That is the decision to weigh, not the engineering.

## Platform support

nomArmy runs natively on Apple Silicon macOS and Linux. On macOS it uses Homebrew for missing command-line dependencies. On Linux, the installer detects Ubuntu/Debian (`apt`), Fedora/RHEL (`dnf` or `yum`), openSUSE (`zypper`), Arch (`pacman`), and Alpine (`apk`), then installs the C++ build toolchain, CMake, Git, curl, Node.js, and npm when missing.

Docker remains a deliberate prerequisite: install Docker Desktop on macOS or Docker Engine on Linux before running the installer. On Windows, use WSL2 with Docker Desktop's WSL integration and run the Linux installation inside your distribution. Native Windows shells are not supported.

On a Linux system without an NVIDIA GPU, use the CPU profile:

```bash
./install.sh --profile cpu-linux --no-claude
./e2e.sh --profile cpu-linux
```

## MacBook Pro: clean E2E

Prerequisites: Apple Silicon macOS, Homebrew, Docker Desktop running, Git, Internet access for installation/model download. The reference path expects enough unified memory for the selected Q4_K_M model and context.

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile macbook-pro
./e2e.sh --profile macbook-pro
```

`install.sh` builds llama.cpp with Metal, installs/configures OpenClaw, starts Qwen, builds the Docker sandbox, and installs the MCP if `claude` is already available.

The E2E test creates a disposable Git repository containing an intentionally broken JavaScript function, asks Qwen through OpenClaw to diagnose/fix it and run the named test, then independently runs the test and checks that the repository actually changed and the worker emitted the required report contract.

Expected end:

```text
PASS inference health
PASS model discovery
PASS worker report contract
PASS autonomous edit + verification
=== E2E PASS ===
```

If Claude Code is installed, verify the final coordinator connection with:

```bash
claude mcp get rayson-local-worker
```

Then copy/merge this package's `CLAUDE.md` into a real repository, start `claude` from that repo, run `/mcp`, and delegate one bounded implementation ticket before increasing worker count.

### OpenClaw local-provider authentication

OpenClaw requires an auth profile even when the llama.cpp server is running only on `127.0.0.1` and accepts requests without a key. `scripts/configure-openclaw.sh` creates a local-only placeholder profile (`llama-cpp:nomarmy-local`); it is not a cloud credential or a secret. The profile lets OpenClaw pass provider configuration into the isolated agent used by `e2e.sh`.

If E2E reports `No API key found for provider "llama-cpp"`, rerun the configuration step, then rerun E2E:

```bash
./scripts/configure-openclaw.sh macbook-pro
./e2e.sh --profile macbook-pro
```

## Codex support

Codex uses `AGENTS.md` for repository guidance. This package includes it alongside `CLAUDE.md` so both coordinators follow the same trust boundary and integration rules.

When the `codex` command is available, `install.sh` also registers the Rayson MCP server. To register it later, run:

```bash
./scripts/setup-codex-worker.sh
codex mcp list
```

The Codex desktop app, CLI, and IDE extension share this local MCP configuration. In Codex, use `/mcp` to confirm that `rayson-local-worker` is available.

## DGX Spark: clean E2E

The DGX Spark profile assumes Linux ARM64, NVIDIA drivers/CUDA toolkit, Docker Engine, Git, Internet access for initial installation/model download, and `sudo` for missing build packages. NVIDIA lists DGX Spark as a Grace Blackwell system with a 20-core Arm CPU and 128 GB coherent unified memory; nomArmy therefore does not assume x86_64 binaries.

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile dgx-spark --no-claude
./e2e.sh --profile dgx-spark
```

That validates the Spark as a self-contained local worker host. If you also install/authenticate Claude Code on the Spark, rerun:

```bash
./scripts/setup-claude-worker.sh
./scripts/verify-install.sh dgx-spark
```

and use Claude there exactly as on the Mac.

### DGX Spark equivalent / other NVIDIA Linux

For an RTX workstation, GB10 OEM system, or other NVIDIA Linux host:

```bash
./install.sh --profile nvidia-linux --no-claude
./e2e.sh --profile nvidia-linux
```

Copy `config/profiles/nvidia-linux.env` to a new profile when a machine needs different context, thread, or parallel-worker settings.

## Moving from Mac to Spark

The repository is the deployment unit. Do not copy a Mac llama.cpp binary or a Mac model runtime directory to the Spark. Clone the repo, select `dgx-spark`, and let `install.sh` build CUDA-native llama.cpp and fetch/cache the model on that host. The coordinator/MCP code is the same on both platforms.

A successful Mac E2E therefore validates agent behavior and packaging; a successful Spark E2E separately validates CUDA/runtime behavior on the target hardware.

## Bedrock: clean E2E

Enable the Anthropic and Qwen models you intend to use in the Bedrock console first, then:

```bash
export AWS_BEARER_TOKEN_BEDROCK=...        # or configure an AWS profile
./install.sh --profile bedrock
./e2e.sh --profile bedrock
```

`install.sh` skips the llama.cpp build entirely on a cloud profile, configures the Docker sandbox before storing any credential, and points OpenClaw at `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`.

Region is a profile variable, not a constant. Set `NOMARMY_BEDROCK_REGION` in `config/profiles/bedrock.env`; it is validated at load, and `scripts/verify-install.sh` confirms each worker model is actually listed in that region before you hit it in a job. Region is also a data-residency decision, not only a latency one.

To point the orchestrator at Bedrock:

```bash
./scripts/configure-orchestrator.sh bedrock           # print the settings
./scripts/configure-orchestrator.sh bedrock --apply   # write them to Claude Code
```

`--apply` merges into the `env` block of `~/.claude/settings.json` and keeps a timestamped backup. Restart Claude Code and run `/status` to confirm the provider and region. Prompt caching is supported on Bedrock and is the single biggest lever on coordinator spend — leave it on. Note that the WebSearch tool is unavailable when Claude Code runs on Bedrock.

### Degraded acceptance

`bedrock-cheap` runs the orchestrator on the same open-weight model as the workers. The mechanical gates still hold — report shape, commit presence, worktree pointer integrity, and `STATUS: done` requiring `VERIFICATION: pass` are all verified against Git by the MCP coordinator regardless of model. What stops working is judgement: a plausible-looking wrong diff, a test that passes for the wrong reason, a regression test that does not pin what it claims.

Every job record under this profile carries `execution.orchestratorTrust: "degraded"` and prints a banner. `policies/reviewer.md` lists what is and is not permitted.

## Configuration naming

Configuration variables are `NOMARMY_*`. Anything still exported as `RAYSON_*` is translated once at profile load with a deprecation warning, so existing installs and unit files keep working. The MCP server itself is still registered as `rayson-local-worker`.

## Starting/stopping inference

```bash
./scripts/start-inference.sh macbook-pro   # or dgx-spark
./scripts/stop-inference.sh macbook-pro
```

Logs are under `$HOME/.local/share/rayson-local-agents/logs/`.

## Sizing noms

Three knobs decide how many noms you get and how much room each one has. They are coupled, and the coupling is easy to get wrong:

| Variable | llama.cpp flag | Meaning |
|---|---|---|
| `NOMARMY_LLAMA_CONTEXT` | `-c` | **Total** context across all slots |
| `NOMARMY_LLAMA_PARALLEL` | `-np` | Inference slots |
| `NOMARMY_MAX_WORKERS` | — | Coordinator job concurrency (noms in flight) |

**`-c` is divided across `-np`.** Each nom gets `NOMARMY_LLAMA_CONTEXT / NOMARMY_LLAMA_PARALLEL`, not the full figure. So `65536` with `2` slots gives each nom 32K. To give two noms 64K each you need `NOMARMY_LLAMA_CONTEXT=131072`. Size by context *per nom* and multiply, never the other way round.

**Do not set `NOMARMY_MAX_WORKERS` above `NOMARMY_LLAMA_PARALLEL` on a local profile.** The extra noms do not run in parallel; they queue for a slot and add latency while consuming a Docker sandbox each. On a Bedrock profile there are no local slots, so `NOMARMY_LLAMA_PARALLEL` is inert and `NOMARMY_MAX_WORKERS` is bounded by your API quota and budget instead.

The v1.3 target is 64K per nom — the autonomous explore/implement/test/repair loop needs more room than a one-shot edit. Trading context for parallelism below that is usually the wrong trade: a nom that exhausts its context mid-repair fails the job, whereas a nom that waits for a slot merely finishes later.

### Measuring instead of guessing

`nomarmy sizing` inspects the machine — cores, RAM, VRAM, unified memory, and the model's own GGUF metadata — and recommends a context/slot/worker combination with the memory arithmetic shown. It also evaluates the profile you already have and reports oversubscription or over-commitment.

It proposes; it does not write. Apply what you agree with, the same way `nomarmy scan` proposes environment configuration rather than provisioning it.

Raising concurrency is an empirical question, not a capacity one. Benchmark accepted tickets/hour, memory pressure, latency, and coordinator interventions before increasing it — a second nom that halves the first one's context can lower throughput.

## Choose another local model

nomArmy uses llama.cpp's Hugging Face integration, so it can run any compatible GGUF language model—not only the bundled Qwen default. Use the interactive selector to search Hugging Face, inspect GGUF quantizations, select an alias, and explicitly confirm the configuration update:

```bash
./scripts/select-model.sh nemotron
```

For NVIDIA's official 4B Nemotron GGUF repository, skip the search step:

```bash
./scripts/select-model.sh --repo nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF
```

The selector updates `config/common.env` only after you answer `y`; it does not download anything until inference restarts. Select a quantization that fits your memory, then restart with the profile you use:

```bash
./scripts/stop-inference.sh
./scripts/start-inference.sh nvidia-linux  # or macbook-pro, dgx-spark, cpu-linux
```

The model is downloaded and cached by llama.cpp on first start. A repository must contain GGUF files; base-model repositories containing only PyTorch or safetensors weights are not directly runnable by this package. For gated repositories, authenticate with Hugging Face and make the required license acceptance before restarting inference.

## Security boundary

The coder receives a writable `/workspace` inside Docker but no outbound network and no host AWS/SSH credentials. OpenClaw is configured for per-session Docker sandboxing and elevated host execution is disabled. The MCP coordinator owns Git state outside the worker sandbox. Failed or incomplete implementation worktrees are retained rather than silently merged.

Do not give the general-purpose coder AWS credentials, production credentials, deployment access, SSH keys, Kubernetes contexts, or production Terraform state.

On cloud profiles the model call is made by the host-side OpenClaw process, not from inside the sandbox, so hosted inference does not widen the coder's blast radius — the sandbox stays `network: none` and `scripts/configure-openclaw.sh` refuses to store a Bedrock credential if it is not. Scope the Bedrock key to `bedrock:InvokeModel` on the worker model ARNs only. What changes on a cloud profile is data flow, not sandbox reach: repository content leaves the machine.

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
scripts/select-model.mjs
scripts/verify-install.sh
setup-claude-local-worker.sh
setup-codex-local-worker.sh
setup-nomarmy-agents.sh
mcp/server.mjs
CLAUDE.md
AGENTS.md
docker/Dockerfile
policies/
```

## Important deployment distinction

nomArmy is portable across Mac and NVIDIA Linux **as a same-host worker/coordinator stack**. The current MCP launches OpenClaw on the machine where the MCP runs. A future centralized-worker release can put Claude/MCP on developer Macs while dispatching complete worker jobs to remote Spark nodes. That remote job-control plane is not falsely claimed here; a remote llama-server alone is not equivalent to remote sandbox/tool execution.
