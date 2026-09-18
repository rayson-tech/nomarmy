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

## Quick start

Pick your host, then follow that link. Each path ends the same way: a passing local end-to-end test.

| Host | Use when | Guide |
|---|---|---|
| macOS (Apple Silicon) | You have a Mac with an M-series chip | [macOS](#macos-apple-silicon-clean-e2e) |
| Windows | You're on Windows | [Windows](#windows) |
| Linux | Ubuntu/Debian/Fedora/Arch/etc., with or without an NVIDIA GPU | [Linux](#linux) |
| NVIDIA DGX Spark | You're setting up a Spark as a dedicated worker host | [DGX Spark](#dgx-spark-clean-e2e) |
| Cloud (no GPU needed) | You'd rather not run local inference at all | [Bedrock](#bedrock-clean-e2e) |

All of them need Git and Docker; the local profiles also need enough memory to hold the model. Run `nomarmy doctor` any time to check a host's readiness with a fix for whatever's missing — see [The `nomarmy` CLI](#the-nomarmy-cli).

## The thesis

> Use scarce frontier intelligence for intent, decomposition, architecture and judgment. Use abundant worker intelligence for repository exploration, implementation, testing, repair loops and verification.

That is a hypothesis, not a claim. nomArmy exists to test it, and the project measures whether it holds rather than assuming it. The number that matters is **cost and wall-clock per accepted task**, plus how often a human has to step in — not tokens displaced.

## The invariant

**Worker output is a claim. Repository and environment state are evidence.**

Everything else follows from that one line. The worker never runs Git. It cannot commit, merge, or mark its own work accepted. It writes a four-line report, and nomArmy independently derives every fact that matters — what changed, what was added, whether the tests actually pass — from the repository itself. A worker that says `done` and a repository that disagrees is a failed job.

A malformed or truncated report is not automatically a failure either: if the repository changed, nomArmy verifies independently and may recover the work. **Failing verification stays failed**, the worktree is retained, and no recovery path can launder it into an accepted job.

### Scouts: the same invariant for reading

Not every job is an edit. The frontier's most expensive habit is reading: every file it opens stays in its context until compaction, and most of what it reads is answering a question rather than making a change. A **scout** is a nom that reads and never writes. It gets a question, a detached snapshot of the base commit, and no permission to modify anything. It hands back findings.

The problem is that a scout's claim *is* the deliverable — there is no Git record to check it against, and if the coordinator re-reads everything to verify the answer, the saving is gone. So the scout contract makes citations mandatory and mechanically checkable:

- every `FINDING` must carry `[path:start-end]`;
- nomArmy resolves each citation against the exact commit the scout read, through Git, not through the worktree — a scout that edits its snapshot cannot forge evidence;
- the cited lines are attached to the finding, so the coordinator reads claim and evidence side by side without opening the file;
- a finding with no resolvable citation is not passed through as a fact. It is listed separately as hearsay.

`CONFIDENCE` is recorded as the scout's own estimate and labelled that way. A scout that writes to its snapshot gets `SCOUT_TAINTED`, a retained worktree, and a banner. See `policies/scout.md`.

Scouts win on breadth, not depth. "Read every test file and list which ones start Docker" is a scout task; a single grep is not. On CPU-only hardware a scout is slower than the frontier doing the lookup itself, so the break-even is a measurement, not a given.

### What that looks like in practice

A real job, run against this repository: *add a `doctor` command to the CLI, with tests.* The worker was a 20B local model. It produced 156 lines that look like competent engineering — JSDoc throughout, pure exported check functions, a distinct remediation message per failed check, `--json` support, logic placed in `lib/` to match the repo's existing layout.

It had six defects:

- an unterminated template literal, so **the file did not parse at all**
- `process.env.PATH || os.platform() === "win32" ? a : b` — `||` binds tighter than `?:`, so on Linux and macOS it silently searched an empty string and found nothing
- executable probing that appended only `.exe`, missing `.cmd` and `.bat`
- output that printed "All checks passed." unconditionally, then appended "Some checks failed."
- checks against `NOMARMY_MODEL_ENDPOINT`, a variable that **does not exist in this project** — it never read the configuration it claimed to validate
- no test file, despite an explicit acceptance criterion

A reviewer skimming that diff would plausibly approve it. It has the shape of good code, and every defect is invisible without executing it: a missing backtick, an operator-precedence subtlety, a fabricated environment variable.

nomArmy committed nothing. The record reads:

```
outcome           WORKER_TIMEOUT
coordinatorStatus incomplete
commit.created    false
worktree          retained
gate              {satisfied: false, reason: "no report parsed"}
testChanges       prod: [bin/nomarmy.mjs, lib/doctor.mjs]   newTests: []
```

Note the last line: production files changed, zero tests added. That is derived from the repository, not from anything the worker said about itself.

This is the entire argument for the design. A review process based on reading the diff fails here. One based on executing it does not.

## Status

nomArmy v1.2 is proven: bounded delegation, isolated worktrees, coordinator-owned Git, retained failed worktrees. v1.3 is in development and extends it toward autonomous workers with real execution environments. Honest state of play:

| Capability | Status |
|---|---|
| Bounded delegation, coordinator-owned Git, retained worktrees | Working, E2E tested |
| Local (llama.cpp) and Amazon Bedrock execution profiles | Working |
| `nomarmy doctor` — host readiness with a fix for every failure | Working, verified on a real host |
| Hardware detection and nom sizing | Working, calibrated against a real OOM |
| Objective + acceptance-criteria briefs, compact worker contract | Built, unit tested |
| Truncated-report recovery, test-change classification, metrics | Built, unit tested |
| `.nomarmy.yml` environment contract — schema, loader, validator | Built, unit tested |
| Deterministic environment scanner and evidence normalizer | Built, unit tested |
| Sandboxed independent verification | Built, unit tested |
| Scout mode — read-only noms with verified, expanded citations | Built, unit tested; not yet run against a live model |
| Background jobs with status polling; memory-pressure admission and context-derived brief/report budgets | Built, unit tested |
| Real worker dispatch against a local model | Run — 6 jobs, 6 correct rejections, 0 accepted |
| Disposable per-job service environments (Postgres, mocks, app) | Not built |
| Nom-local browser/E2E and the autonomous repair loop | Not built |
| Fresh integrated PR-gate environment | Not built |
| Full-stack acceptance test proving the thesis end to end | **Not yet run** |

"Built, unit tested" means the logic is covered by tests; it does not mean it has survived a live worker on a real ticket. The dispatch row is the one worth dwelling on: six jobs have run against a local model and the gate rejected every one — correctly, including a worker that returned confident, well-structured, unparseable code. That demonstrates the gate works. It does not yet demonstrate that a cheap worker can pass it, and the last row remains open.

Known limitations worth knowing up front: the Compose parser does not resolve YAML anchors, aliases or merge keys — affected findings are dropped with an explicit note rather than guessed at. Verification profiles requiring services beyond `environment: none` currently report `not_run` rather than running commands without their dependencies.

On performance: a CPU-only host runs this honestly but slowly — measured at ~3.8 tok/s generation on a 20-core i7 with an 11.3 GiB MoE model, which works out to roughly 11 minutes for two assistant turns. Use a GPU or a hosted profile for interactive work; see [Speed matters more than fit](#speed-matters-more-than-fit).

## The MCP tools

The coordinator drives nomArmy through the `nomarmy-local-worker` MCP server. Every job takes the same brief: a `task` (an objective for `implement`, a question for `scout`), optional `acceptance` items, a `mode`, and a timeout.

| Tool | What it does |
|---|---|
| `local_worker` | Run one job and wait for it. Blocks the coordinator for the duration. |
| `local_worker_start` | Start one job in the background and return a `job_id` immediately. |
| `local_worker_status` | Phase, elapsed time against the timeout, and the result once finished. `wait_seconds` long-polls; `full=true` returns the complete report. |
| `local_worker_capacity` | Context per nom, the brief and report budgets derived from it, memory pressure, and what is running. Read-only. |
| `local_workers` | Run a batch with bounded parallelism and wait for all of them. Never merges. |
| `local_worker_jobs` | Recent job records, including jobs still running or orphaned by a server restart. |
| `local_worker_cleanup` | Remove a retained worktree after review. Refuses to delete the current branch. |

The phases a poller sees — `starting`, `worktree`, `worker`, `verification`, `commit`, `record`, `finished` — are the ones nomArmy itself passes through. Inside the `worker` phase the only honest signal is elapsed time, and the status says so rather than inventing a percentage.

**Admission.** Every job, blocking or backgrounded, passes the same check before anything starts. Two resources, two rules, deliberately not conflated:

- *Context per nom bounds text.* The brief ceiling, the report caps, and a scout's finding and excerpt budgets are derived from the context one nom actually has — from the loaded profile, or from the running llama-server's own `/props`. A smaller context means a shorter brief, not a bigger prompt into a model that cannot hold it. `nomarmy sizing` prints the budgets for its recommendation; `local_worker_capacity` prints the live ones.
- *Free memory bounds admission.* Starting one more job adds a sandbox container and an OpenClaw process, never a second copy of the model. If the machine cannot hold that right now, or `NOMARMY_MAX_WORKERS` jobs are already running, the job is refused with the reason and the current capacity, and nothing is started. nomArmy does not shrink the brief and hope.

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
- the `nomarmy` CLI, with its dependencies installed and linked onto your PATH
- platform profiles, nom sizing, and E2E verification

It intentionally does **not** install or authenticate Claude Code. Claude credentials are a user/organization concern. A DGX worker can therefore be provisioned with `--no-claude`, while a machine that will run the Claude coordinator can register the MCP locally.

## Profiles

- `macbook-pro`: Apple Silicon / Metal, 64K active llama context, one inference slot, one worker.
- `dgx-spark`: NVIDIA Linux ARM64 / CUDA, 64K active llama context, two inference slots, two workers initially.
- `nvidia-linux`: generic NVIDIA Linux/CUDA, conservative 32K/one-worker defaults.
- `cpu-linux`: generic Linux without CUDA. This is the portable fallback and uses a smaller 16K context.

All values live in `config/common.env` and `config/profiles/*.env`. Hardware tuning is configuration, not coordinator code. Run `nomarmy sizing` before trusting any of these defaults on your actual machine — see [Sizing noms](#sizing-noms).

### Cloud profiles

- `bedrock`: workers and orchestrator both served from Amazon Bedrock. No local inference, so this profile carries no GPU or OS requirement and is the only one that runs on a machine without a GPU. Workers run `qwen.qwen3-coder-next` — the same model the local profiles run, which makes local vs hosted a clean A/B rather than a model swap. The orchestrator is Claude Opus 5, so the coordinator still outranks the workers it reviews.
- `bedrock-cheap`: same workers, but the orchestrator is the same open-weight model. **Degraded acceptance** — see `policies/reviewer.md` before using it.

Local profiles cost nothing per token and are capped by VRAM. Bedrock profiles are capped by TPM quota and budget, so `NOMARMY_MAX_WORKERS` above 1 is reachable. Measure first-pass accept rate before raising it: coordinator review tokens dominate worker tokens, so a cheaper worker that fails the gate more often is not cheaper.

Cloud profiles send repository content off the machine. That is the decision to weigh, not the engineering.

## The `nomarmy` CLI

`install.sh` installs the repository's dependencies and links `nomarmy` onto your PATH. If you only want the CLI — to inspect a repository or size a machine before committing to a full install — that part stands alone:

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
npm install
npm link          # optional; puts `nomarmy` on PATH
```

Without `npm link`, every command works the same way run directly:

```bash
node bin/nomarmy.mjs doctor
```

`npm install` is not optional. The CLI imports from `lib/`, which has real dependencies, so a fresh clone cannot run any command until they are present.

| Command | What it does |
|---|---|
| `nomarmy doctor` | Checks this host is ready to run nomArmy and prints a fix for anything missing. Start here. |
| `nomarmy sizing` | Recommends context and nom count from your hardware and the model's own GGUF metadata, and prints the brief and report budgets a nom at that context can carry. `--check` evaluates the profile you already have. |
| `nomarmy scan` | Reports a repository's execution environment from deterministic evidence. `--check` compares it against a committed `.nomarmy.yml`. |
| `nomarmy validate` | Validates `.nomarmy.yml` against the schema and flags services needing explicit policy approval. |

Every command takes `--json` for machine-readable output, and `--repo <dir>` to target a repository other than the working directory.

None of them change anything. `scan` never executes what it discovers, `sizing` never writes a profile, and `doctor` never installs anything — they report and propose, and you apply what you agree with.

## Platform guides

Native support is macOS (Apple Silicon) and Linux. Windows runs nomArmy through WSL2. Each guide below ends with a passing `./e2e.sh` run.

### macOS (Apple Silicon): clean E2E

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
claude mcp get nomarmy-local-worker
```

Then copy/merge this package's `CLAUDE.md` into a real repository, start `claude` from that repo, run `/mcp`, and delegate one bounded implementation ticket before increasing worker count.

**OpenClaw local-provider authentication.** OpenClaw requires an auth profile even when the llama.cpp server is running only on `127.0.0.1` and accepts requests without a key. `scripts/configure-openclaw.sh` creates a local-only placeholder profile (`llama-cpp:nomarmy-local`); it is not a cloud credential or a secret. The profile lets OpenClaw pass provider configuration into the isolated agent used by `e2e.sh`.

If E2E reports `No API key found for provider "llama-cpp"`, rerun the configuration step, then rerun E2E:

```bash
./scripts/configure-openclaw.sh macbook-pro
./e2e.sh --profile macbook-pro
```

### Windows

`install.sh` does not run natively on Windows (`.sh` scripts, Docker sandboxing, and llama.cpp's build tooling all assume a POSIX host). Three real options, roughly in the order most people should try them:

1. **WSL2 + Docker Desktop's WSL integration (supported path).** Install a Linux distribution under WSL2, enable Docker Desktop's WSL integration for it, then follow the [Linux](#linux) guide entirely inside that distribution.

   One trap: WSL2 defaults to ~50% of host RAM, shared across every distro *including* `docker-desktop`. On a 32 GB machine that caps the model at ~16 GB. Raise the limit in `%UserProfile%\.wslconfig`, then run `wsl --shutdown` — this restarts every running container, so do it before you start inference, not after.

   A second trap: every job gets its own worktree under the state directory, so every repository path grows by that prefix. Without `git config --global core.longpaths true`, a repository with a deep tree fails at `git worktree add` with `Filename too long`. `nomarmy doctor` checks for this on Windows.

2. **Native Windows llama.cpp, built from source, with nomArmy pointed at it.** Gets the full host RAM instead of WSL2's slice, at the cost of building llama.cpp yourself. Needs a C++ toolchain:

   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

   Prebuilt llama.cpp Windows binaries are not a reliable shortcut: on some CPUs every compute backend crashes at startup (access violation) while non-compute binaries run fine, because of dynamic backend loading. Build statically instead — these flags are verified working:

   ```powershell
   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_BACKEND_DL=OFF -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=ON -DLLAMA_CURL=OFF
   ```

   `GGML_BACKEND_DL=OFF` is the flag that matters: it links the CPU backend in rather than probing for it at runtime.

3. **Skip local inference entirely and run workers on Bedrock:**

   ```bash
   ./install.sh --profile bedrock
   ```

   See [Bedrock: clean E2E](#bedrock-clean-e2e).

Whichever you're leaning toward, run `nomarmy sizing` first (see [The `nomarmy` CLI](#the-nomarmy-cli)) — it reports which of these your actual hardware can support before you commit to one.

### Linux

The installer detects Ubuntu/Debian (`apt`), Fedora/RHEL (`dnf` or `yum`), openSUSE (`zypper`), Arch (`pacman`), and Alpine (`apk`), then installs the C++ build toolchain, CMake, Git, curl, Node.js, and npm when missing. Docker Engine is a deliberate prerequisite: install it before running the installer.

On a Linux system **without** an NVIDIA GPU, use the CPU profile — this is the portable fallback, with a smaller 16K context to match:

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile cpu-linux --no-claude
./e2e.sh --profile cpu-linux
```

On a Linux system **with** an NVIDIA GPU (an RTX workstation, a GB10 OEM system, or similar — not a DGX Spark, which has its own profile below):

```bash
./install.sh --profile nvidia-linux --no-claude
./e2e.sh --profile nvidia-linux
```

Copy `config/profiles/nvidia-linux.env` to a new profile when a machine needs different context, thread, or parallel-worker settings.

CPU-only Linux is viable but slow for interactive use — read [Speed matters more than fit](#speed-matters-more-than-fit) before you plan around it.

### DGX Spark: clean E2E

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

**Moving from Mac to Spark.** The repository is the deployment unit. Do not copy a Mac llama.cpp binary or a Mac model runtime directory to the Spark. Clone the repo, select `dgx-spark`, and let `install.sh` build CUDA-native llama.cpp and fetch/cache the model on that host. The coordinator/MCP code is the same on both platforms, so a successful Mac E2E validates agent behavior and packaging, while a successful Spark E2E separately validates CUDA/runtime behavior on the target hardware.

### Bedrock: clean E2E

No GPU, no local build — the option to reach for on Windows, on underpowered hardware, or whenever you'd rather not run inference locally at all.

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

**Degraded acceptance.** `bedrock-cheap` runs the orchestrator on the same open-weight model as the workers. The mechanical gates still hold — report shape, commit presence, worktree pointer integrity, and `STATUS: done` requiring `TESTS: pass` are all verified against Git by the MCP coordinator regardless of model. What stops working is judgement: a plausible-looking wrong diff, a test that passes for the wrong reason, a regression test that does not pin what it claims.

Every job record under this profile carries `execution.orchestratorTrust: "degraded"` and prints a banner. `policies/reviewer.md` lists what is and is not permitted.

## Codex support

Codex uses `AGENTS.md` for repository guidance. This package includes it alongside `CLAUDE.md` so both coordinators follow the same trust boundary and integration rules.

When the `codex` command is available, `install.sh` also registers the nomArmy MCP server. To register it later, run:

```bash
./scripts/setup-codex-worker.sh
codex mcp list
```

The Codex desktop app, CLI, and IDE extension share this local MCP configuration. In Codex, use `/mcp` to confirm that `nomarmy-local-worker` is available.

## Configuration naming

Configuration variables are `NOMARMY_*`. Anything still exported as `RAYSON_*` is translated once at profile load with a deprecation warning, so existing installs and unit files keep working. The MCP server itself is registered as `nomarmy-local-worker`.

## Starting/stopping inference

```bash
./scripts/start-inference.sh macbook-pro   # or dgx-spark
./scripts/stop-inference.sh macbook-pro
```

Logs are under `$HOME/.local/share/nomarmy-local-agents/logs/`.

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

`nomarmy sizing` inspects the machine — cores, RAM, VRAM, unified memory, and the model's own GGUF metadata — and recommends a context/slot/worker combination with the memory arithmetic shown. It also evaluates the profile you already have and reports oversubscription or over-commitment. It checks memory pressure at the moment you run it, too: a recommendation that fits the machine's total RAM can still refuse to start right now if something else already has most of it in use.

It proposes; it does not write. Apply what you agree with, the same way `nomarmy scan` proposes environment configuration rather than provisioning it. Restarting inference to pick up a changed value is a separate manual step — `start-inference.sh` does nothing if a server is already running, so a config change alone does not take effect until you stop and start it.

Raising concurrency is an empirical question, not a capacity one. Benchmark accepted tickets/hour, memory pressure, latency, and coordinator interventions before increasing it — a second nom that halves the first one's context can lower throughput.

### Speed matters more than fit

`nomarmy sizing` answers *"what fits in memory?"* It does not answer *"is this fast enough to be useful?"*, and on CPU-only hardware those are very different questions.

Measured on a 20-core i7-1280P, no GPU, running gpt-oss-20b (MXFP4, 11.3 GiB, MoE with ~3.6B active parameters — a favourable case, not a worst case):

| | |
|---|---|
| Generation | ~3.8 tokens/sec |
| Prompt processing | ~6.7 tokens/sec |
| Two assistant turns on a real job | **11.5 minutes** |

Sizing will happily report that this machine runs *2 noms at 64K each*, and that is true. It is also close to unusable for interactive work: an autonomous explore → implement → test → repair loop needs many turns, so a single bounded job runs to an hour or more.

Two consequences worth planning around:

**Turn count dominates, not token count.** Every tool-call round re-reads context. llama.cpp caches the prefix within a slot so growth is incremental rather than a full reprocess, but a worker that explores widely pays for it repeatedly. A tighter objective is worth more than a bigger context.

**Provider timeouts must match the model, not the vendor default.** A single model call can exceed a hosted-inference-shaped timeout, and the worker is then killed mid-turn regardless of nomArmy's own job timeout — the two ceilings are independent. `configure-openclaw.sh` sets both; raise them with `NOMARMY_PROVIDER_TIMEOUT_SECONDS` and `NOMARMY_AGENT_TIMEOUT_SECONDS` if your hardware is slower still.

Rules of thumb: **GPU or a hosted profile for interactive work.** CPU-only is viable for overnight or batch runs, and genuinely useful as a correctness testbed — it exercises the whole pipeline honestly, just slowly. Treat a CPU-only local profile as something you are testing, not something you are depending on.

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
bin/nomarmy.mjs
lib/budget.mjs        context-derived budgets, memory-pressure admission
lib/scout.mjs         scout report contract, citation verification
lib/sizing.mjs        hardware -> context/nom recommendation
lib/hardware.mjs  lib/gguf.mjs  lib/doctor.mjs
lib/config.mjs    lib/schema.mjs  lib/scan.mjs  lib/evidence.mjs  lib/verify.mjs
tests/
CLAUDE.md
AGENTS.md
docker/Dockerfile
policies/coder.md  policies/scout.md  policies/orchestrator.md  policies/reviewer.md
```

## Important deployment distinction

nomArmy is portable across Mac and NVIDIA Linux **as a same-host worker/coordinator stack**. The current MCP launches OpenClaw on the machine where the MCP runs. A future centralized-worker release can put Claude/MCP on developer Macs while dispatching complete worker jobs to remote Spark nodes. That remote job-control plane is not falsely claimed here; a remote llama-server alone is not equivalent to remote sandbox/tool execution.
