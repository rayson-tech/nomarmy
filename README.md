# nomArmy

<img src="nomarmy-logo.png" alt="nomArmy logo" width="320">

[![CI](https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml/badge.svg)](https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

> Tiny local coders, big appetites for bounded tickets. 🍪

**An agent harness where the worker's claims are never trusted, and the environment your tests need is declared, disposable and reproducible.**

A frontier coordinator (Claude Code, Codex) decides *what* should be built and whether the result is acceptable. A cheap worker (a *nom*) implements, tests and repairs, usually on a local model at zero token cost. nomArmy owns everything in between: worktrees, Git, environments, verification, and the evidence that decides whether work is accepted.

Developed and maintained by Rayson Technologies.

## New to local LLMs?

| Term | Meaning |
|---|---|
| **GGUF** | The file format `llama.cpp` loads a model from. |
| **Quantization** (e.g. `Q4_K_M`) | A compressed version of a model's weights: smaller/faster, some quality cost. `Q4_K_M` is nomArmy's default. |
| **Context window** | The total tokens a model can hold at once: prompt + reads + writes, one shared budget. |
| **llama.cpp / llama-server** | The engine nomArmy uses to run a local GGUF model over an OpenAI-compatible HTTP API. |
| **Sandbox** | An isolated Podman container a worker's tool calls run inside: no network, no host credentials. |
| **A "nom"** | One worker: a job dispatched to a local (or hosted) model in its own disposable Git worktree. |

## Install

| Platform | Guide |
|---|---|
| macOS (Apple Silicon) | [macOS](#macos-apple-silicon) |
| Linux (with or without an NVIDIA GPU) | [Linux](#linux) |
| Windows | [Windows](#windows) |
| NVIDIA DGX Spark | [DGX Spark](#dgx-spark) |
| No GPU / no local inference | [Cloud (Bedrock)](#cloud-bedrock) |

Every platform needs Git and Podman. `nomarmy doctor` checks host readiness and prints a fix for anything missing.

### macOS (Apple Silicon)

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile macbook-pro
./e2e.sh --profile macbook-pro
```

`install.sh` builds llama.cpp with Metal, installs/configures OpenClaw, starts the model, builds the sandbox, and registers the MCP server if Claude Code is present. Expect:

```text
PASS inference health
PASS model discovery
PASS worker report contract
PASS autonomous edit + verification
=== E2E PASS ===
```

Then copy this repo's `CLAUDE.md` into a real project, start Claude Code there, run `/mcp`, and delegate one small ticket before raising worker count.

If `e2e.sh` says `No API key found for provider "llama-cpp"`: `./scripts/configure-openclaw.sh macbook-pro`, then rerun `e2e.sh`.

### Linux

Installs the toolchain/CMake/Git/Node when missing. Install Podman yourself first (`apt`/`dnf`/`zypper`/`pacman`/`apk install podman`).

```bash
# no NVIDIA GPU
./install.sh --profile cpu-linux --no-claude && ./e2e.sh --profile cpu-linux

# with an NVIDIA GPU (not a DGX Spark -- see below)
./install.sh --profile nvidia-linux --no-claude && ./e2e.sh --profile nvidia-linux
```

CPU-only Linux works but is genuinely slow for interactive use: see [Speed matters more than fit](#speed-matters-more-than-fit).

### Windows

`install.sh` doesn't run natively. In order of preference:

1. **WSL2** (supported path): install a Linux distro under WSL2, install Podman inside it, run the [Linux](#linux) guide entirely inside the distro. Watch for WSL2's default ~50% RAM cap (`.wslconfig`) and `git config --global core.longpaths true` (`nomarmy doctor` checks this).
2. **Native Windows llama.cpp**, built from source: more RAM, more setup. Prebuilt binaries aren't a safe shortcut (some CPUs crash every backend at startup).
3. **Skip local inference**: `./install.sh --profile bedrock`, see [Cloud (Bedrock)](#cloud-bedrock).

Unsure which? `nomarmy sizing` reports what your hardware can actually support.

### DGX Spark

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile dgx-spark --no-claude
./e2e.sh --profile dgx-spark
```

Moving from a Mac install: don't copy a Mac binary or model cache over: clone fresh and let `install.sh` build CUDA-native llama.cpp on that host.

### Cloud (Bedrock)

No GPU, no local build:

```bash
export AWS_BEARER_TOKEN_BEDROCK=...   # or configure an AWS profile
./install.sh --profile bedrock
./e2e.sh --profile bedrock
```

Enable the models you intend to use in the Bedrock console first. `bedrock-cheap` runs the orchestrator on the same open-weight model as the workers: real savings, materially weaker guarantee (see `policies/reviewer.md`).

## Configuration

- **`config/common.env`**: defaults shared by every profile.
- **`config/profiles/<name>.env`**: per-machine overrides (context size, GPU layers, threads, workers).
- **A shell-exported variable** wins over both.

Every variable is documented next to itself in those two files: that's the source of truth.

| Variable | Lives in | Default | Controls |
|---|---|---|---|
| `NOMARMY_WORKER_MODEL` | common.env | `qwen3-coder-next` | Which model runs jobs |
| `NOMARMY_MODEL_REPO` / `_QUANT` | common.env | `Qwen/Qwen3-Coder-Next-GGUF` / `Q4_K_M` | Which GGUF to download |
| `NOMARMY_LLAMA_CONTEXT` | profile | `65536` | **Total** context across all slots |
| `NOMARMY_LLAMA_PARALLEL` | profile | `1` | Inference slots (context is divided across these) |
| `NOMARMY_MAX_WORKERS` | profile | `1` | Coordinator job concurrency |
| `NOMARMY_EXECUTION` | common.env | `local` | `local` or `bedrock` |
| `NOMARMY_ORCHESTRATOR_TRUST` | common.env | `frontier` | `frontier` or `degraded`: see `policies/reviewer.md` |

**The coupling that trips people up**: `NOMARMY_LLAMA_CONTEXT` is divided by `NOMARMY_LLAMA_PARALLEL`, not given to each slot whole: `65536` ÷ `2` slots = `32768` per nom. Size by context-per-nom and multiply up. See [Sizing noms](#sizing-noms).

A config change needs an inference restart: `nomarmy stop && nomarmy start`.

### Swapping models

```bash
nomarmy model
```

Offers three measured choices (Qwen3-Coder-Next, gpt-oss-20b, Qwen3.6-27B: see `docs/experiments/2026-09-20-model-bakeoff-and-economics.md`) or a Hugging Face search. Also offers to resync the MCP registration and restart inference in the same command: all three (config, registration, running process) need to agree, and it's easy for them to drift silently otherwise.

## Agents: every model a job can run on

One list, `~/.config/nomarmy/agents.yml` (or `NOMARMY_CONFIG_DIR`), names each account a job can run on and says how to reach it. An api or subscription agent is the **account**, not a model: which model runs is picked per role or per job (below), and a `model` on the agent is only an optional default. There are three kinds:

| Kind | What it is | Set up with |
|---|---|---|
| `local` | the local llama-server model. `local` is built in; add `local-gpt` for the gpt slot | nothing |
| `api` | a metered API key: `xai`, `openai`, `anthropic`, `deepinfra`, `bedrock` / `azure-openai` / `openai-compatible` (need `base_url`), or `openclaw` for any other OpenClaw provider by id (e.g. DeepSeek, with an optional `plugin` installed first) | `nomarmy agents add api` |
| `subscription` | **one person's own** Claude, ChatGPT or Muse Code plan; never pooled, and every job must name its owner | `nomarmy agents add subscription claude\|codex\|meta` |

```bash
nomarmy agents add        # asks which kind, then walks through it
nomarmy agents list
nomarmy agents update codex --json --model gpt-6-sol
```

`agents add` does the whole chain for each kind, asking only when something needs doing. For an **api** agent it registers the key with OpenClaw over stdin (typed once, or read from the env var you name) and makes a test call; `agents.yml` only ever holds the variable's *name*. For a **subscription** it installs the vendor CLI if missing (`@openai/codex`; Claude Code and Muse Code have their own installers), runs that CLI's login, updates OpenClaw and installs its plugin when the vendor needs one, runs OpenClaw's own login where needed, lists the real models, defaults the owner to the account you logged in as, and makes a real one-token test call before saving. For Meta it also copies the key Muse Code's login minted into the macOS keychain into OpenClaw over stdin (Meta's docs say only that auto-connected key is flat-rate; hand-made keys bill pay-as-you-go). nomArmy starts each login; the vendor CLI and OpenClaw do the authenticating.

```yaml
# ~/.config/nomarmy/agents.yml   (see config/agents.yml.example)
agents:
  claude: { kind: subscription, provider: claude-cli, owner: you@example.com }
  codex:  { kind: subscription, provider: openai, owner: you@example.com }
  grok:   { kind: api, provider: xai, auth_env: NOMARMY_XAI_API_KEY, thinking: high }
```

A job picks an agent through a role (`army_role`, below) or directly (`agent: "codex"`); with neither it runs on `local`. The **model** is, first to last: the job's own `model` (the General's choice), the role's model unless it's `auto` (which leaves it to the General), then the agent's default. No model at all is refused, never guessed. Nothing picks between agents at random. Changes apply to the next job with no restart, except that a **new** api agent needs one `nomarmy connect claude` so the MCP server sees its key variable (`agents add` offers to do it).

**Settings**: `max_concurrent` (default 2 for api, 1 for a subscription: a personal session was never provisioned for parallel automation); `thinking` (`true` follows the job's level, `false` is off, or a fixed `low`/`medium`/`high`); `context_window` to override OpenClaw's catalog for a model newer than it knows (otherwise the catalog value is used, with a safety margin). Api jobs get their own concurrency ceiling (`NOMARMY_MAX_POOL_WORKERS`), additive to local workers.

**Why subscriptions are individual, never pooled**: Anthropic's terms distinguish "individual experimentation and automation" (sanctioned, including third-party apps through the Agent SDK; per-seat and non-transferable across Pro, Max, Team and Enterprise) from "teams running shared production automation" (use the metered API). So a subscription agent is one named person's, a job on it must say `on_behalf_of: "<owner>"` or it's refused, and nothing ever load-balances across subscriptions.

**One credential per provider id**: OpenAI, Meta and xAI keep the subscription and the API key under the same OpenClaw provider id, so `agents.yml` refuses an api agent and a subscription agent on the same one (and `agents add subscription` stops before any login). Only Claude never collides: its subscription is `claude-cli`, its API key is `anthropic`. A ChatGPT plan runs as `openai/<model>` on the OAuth profile the Codex login imports.

**Vendor status**: Claude is live-verified end to end. OpenAI (ChatGPT via Codex): a real completion through `openai/gpt-6-astra` is confirmed; a full nomArmy dispatch and OpenAI's own usage-policy text are still unverified. Meta Muse Code is wired but not yet live-verified, and macOS only for now. xAI subscriptions are out of scope until its terms are resolved (an xAI API key is fine). Api providers other than `xai` are built from OpenClaw's documented interface and not all verified against a real key.

**Picking an agent**: `local` for a bounded change against a written spec with a test; it never leaves your machine. An api or subscription agent when the work needs more than the local model, knowing it sends code to that vendor: a decision about where source travels, separate from the trust boundary. The coordinator itself when the answer isn't known yet.

**Honest gaps**: `worker_cost_usd` in job metrics is best-effort, not authoritative. `on_behalf_of` is a self-reported attestation, not an independently verified identity check; nomArmy has no caller-identity boundary today. See [Security posture](#security-posture) / `SECURITY.md`.

## The army: who does what

The **General** is your coordinator session (Claude Code, Codex, Cursor). Its charter is fixed by nomArmy, not configured: it plans and decomposes, makes the architecture and security decisions, briefs and dispatches each role, reviews every result against nomArmy's verified record, owns Git and integration, and gives final acceptance. It runs outside every sandbox and is never dispatched to. What you *do* define is which agent it is, after your agents exist:

```bash
nomarmy army general claude              # the agent for your Claude seat
```

That lets nomArmy flag a role on the General's own agent (a review that isn't independent) or on the same subscription login (the same usage limit).

Every other role is yours to define: a name, a description of when the General calls it, a phase, and the agent it runs on.

```bash
nomarmy army init                              # the default roster, globally
nomarmy army assign sr-dev codex gpt-6-astra   # an agent, and the model to run on it
nomarmy army assign pm codex auto              # the General picks the model per job
nomarmy army assign ui-ux codex gpt-6-astra --project   # this repo, committed
nomarmy army assign security-analyst grok grok-4.7 --local   # just you, just this repo
nomarmy army show                              # the General, the roster, and which layer set what
```

The default roster follows a normal SDLC: the **Sr Dev** does the first cut, handing simple work to **Jr Devs** and keeping the harder implementation; **UI/UX** gets UI work. Once the General hears the build is done, it calls the specialists who apply (**data architect**: star schema / medallion; **security analyst**), then the **PM** reviews against the plan, then the **PO** and **stakeholders** test end to end. Not every role runs every time. Every role starts on `local`; reassign whichever you like.

A job dispatches with `army_role: "security-analyst"`: nomArmy runs it on that role's agent and heads the brief with the role's description. The General reads everything through the read-only `army` MCP tool. Edits apply to the next job, no restart.

**Config layers**, merged like Claude Code's settings (later wins, field by field):

| Layer | File | Committed | Holds |
|---|---|---|---|
| global | `~/.config/nomarmy/config.yml` | no | your default army and your General |
| project | `<repo>/.nomarmy.yml` (`army:` section, beside `verification:`) | yes | the team's roles for this repo (never the General) |
| local | `<repo>/.nomarmy.local.yml` | no, and a tracked copy is refused | your overrides for this repo |

An army section can only **name agents**: it has no field for a credential, endpoint, owner or provider, so a hostile `.nomarmy.yml` in a cloned repo can at worst route a job to one of your own agents. That's also why a project file uses generic agent names (`codex`, not `jason-codex`): each teammate defines an agent by that name in their own `agents.yml`, on their own login.

**Shared machines (a team DGX Spark)**: give each person their own OS account. Subscription logins live in that account's home directory (`~/.claude`, `~/.codex`, OpenClaw's auth store, the OS keychain), never in any nomArmy file, so each teammate's coordinator session only ever reaches their own subscriptions. nomArmy refuses an `agents.yml` that another account owns or can write. One shared OS account for several people is the pooling this design exists to prevent, and `on_behalf_of` can't detect it. Each session's MCP server counts only its own jobs, so on a shared machine `NOMARMY_MAX_WORKERS` doesn't cap the machine as a whole yet.

**The sandbox and the network**: a worker's sandbox has no network (`network: none`), which covers its shell, file edits and test commands: no `npm install` of a new package, no `curl`. The model call itself is made by OpenClaw on the host, so an api or subscription agent reaches its vendor normally.

## `/feature`: a feature, end to end

```
/feature add join partners to the schema context
```

The General (your coordinator session) runs the army's whole workflow on its own and comes back when it's done: a plan, the build (Sr Dev, Jr Dev, UI/UX), the reviews that apply (data architect, security analyst, then the PM against the plan), and acceptance (PO, stakeholder), with fixes sent back to the builders along the way. It ends with **a branch ready for you to review and merge**: nomArmy never merges or pushes, and it never deploys or touches cloud credentials, so those are hard stops. For any other decision it would normally ask you about, it picks the conservative option, records it, and keeps going; every such decision is in the final report.

`nomarmy connect` installs it for each coordinator: `/feature` in Claude Code (`~/.claude/commands/`), a `nomarmy-feature` skill in Codex (`~/.codex/skills/`), and `/feature` in Cursor (`~/.cursor/commands/`; that path follows Cursor's documentation and hasn't been tested against a real install). A same-named command of your own is never overwritten.

**Limits.** Each feature is a *run* (`run_start`), and every job carries its `run_id`. Admission enforces the run's limits and warns at 80%:

```yaml
# ~/.config/nomarmy/config.yml (or .nomarmy.local.yml; never the committed .nomarmy.yml)
army:
  run_limits:
    max_jobs: 40        # defaults shown
    max_api_usd: 10     # api agents only; a subscription isn't billed per call
    max_hours: 6
    warn_at: 0.8
```

The General can lower these for one run, never raise them. When a vendor answers with a usage-limit error, that agent is paused for the rest of the run and the General stops and tells you; it never moves the role to another vendor to get around it. The one thing no tool can see is your coordinator's own seat: if it runs out mid-feature, the run log (kept current after every phase) lets `/feature resume <run-id>` in a fresh session continue instead of starting over.

## The `nomarmy` CLI

Not published to npm (`"private": true`): clone and `npm install && npm link` (done for you by `install.sh`), or run commands directly: `node bin/nomarmy.mjs doctor`.

Every command proposes before writing anything: explicit `[y/N]` confirmation, or an explicit flag standing in for one under `--json`. None touch system-level infrastructure; `install.sh` stays a separate, manual step.

| Command | What it does |
|---|---|
| `nomarmy doctor` | Host readiness, with a fix for anything missing. Start here. |
| `nomarmy setup` | Detect the machine, recommend a profile, choose a model, write config. Prints (never runs) `install.sh`. |
| `nomarmy init` | Propose `.nomarmy.yml` from scan evidence. |
| `nomarmy model` | Change the model later. See [Swapping models](#swapping-models). |
| `nomarmy agents list/add/update/remove` | Every model a job can run on. See [above](#agents-every-model-a-job-can-run-on). |
| `nomarmy army show/init/assign/general` | The General, the role roster and its layers. See [above](#the-army-who-does-what). |
| `nomarmy config paths` | Where each config file lives. |
| `nomarmy jobs [--watch]` | What's running across every session (agent, model, phase, last tool call, files changed, heartbeat) and what just finished. `--watch` redraws live; macOS has no `watch`. |
| `nomarmy update` | Pull latest (fast-forward only) and resync the installed MCP copy. |
| `nomarmy connect [claude] [cursor] [codex]` | (Re-)register the MCP server. No target: interactive multi-select. |
| `nomarmy start` / `stop` | Start/stop local inference. |
| `nomarmy uninstall` | Remove MCP registration + install dir. `--clear-agents`/`--clear-models`/`--all` for deeper cleanup. |
| `nomarmy sizing` | Recommend context/slot/worker counts from hardware + model metadata. `--check` evaluates the loaded profile; `--noms N` sizes for an exact count. |
| `nomarmy scan` | Report a repo's execution environment from deterministic evidence. `--check` diffs against a committed `.nomarmy.yml`. |
| `nomarmy validate` | Validate `.nomarmy.yml` against the schema. |

All commands take `--json` and `--repo <dir>`.

## Sizing noms

Three coupled knobs: `NOMARMY_LLAMA_CONTEXT` (`-c`, total context), `NOMARMY_LLAMA_PARALLEL` (`-np`, slots), `NOMARMY_MAX_WORKERS` (coordinator concurrency). `nomarmy sizing` inspects hardware + the model's GGUF metadata and recommends a combination, checking live memory pressure too.

Target: 64K context per nom: an autonomous explore/implement/test/repair loop needs more room than a one-shot edit. `nomarmy sizing`/`setup` show **More noms** (max that fits) vs **Nominal** (1 nom, what every shipped profile actually uses) when they differ; raising worker count is an empirical question, not a capacity one: measure accepted-tickets/hour before assuming more is faster (on one tested Apple Silicon machine, going from 1 to 4 parallel workers produced *zero* net throughput gain).

### Speed matters more than fit

CPU-only hardware: measured ~3.8 tok/s generation on a 20-core i7, no GPU (gpt-oss-20b MXFP4): an 11.5-minute job for two assistant turns. Turn count dominates over token count on slow hardware; a tighter objective is worth more than a bigger context window. **Rule of thumb: GPU or a hosted profile for interactive work**; CPU-only is a correctness testbed, not something to depend on.

Advanced llama-server tuning (`NOMARMY_LLAMA_CACHE_TYPE_K/V`, `_FLASH_ATTN`, `_REASONING_BUDGET`, `_REASONING_PRESERVE`, `_EXTRA_ARGS`) is documented inline in `config/profiles/*.env`; unset by default, none validated by nomArmy.

## Starting/stopping inference

```bash
nomarmy start   # or: ./scripts/start-inference.sh <profile>
nomarmy stop
```

Logs land under `$HOME/.local/share/nomarmy-local-agents/logs/`.

## Target repository languages

| Language | Detection | Sandbox toolchain |
|---|---|---|
| Node | `package.json` | Built into the base image |
| Python (runtime only) | `pyproject.toml` | Built into the base image |
| Go / Rust | `go.mod` / `Cargo.toml` | Built lazily, on first use, cached after |
| Python (with dependencies) | `requirements.txt`, or `environment.python.requirements` in `.nomarmy.yml` | Built lazily per repo, keyed on dependency content |

```yaml
environment:
  python:
    requirements:
      - requirements-dev.txt
      - lambda/requirements.txt
```

A worker's own tool calls (not just nomArmy's verification step) get the same resolved sandbox image automatically. `NOMARMY_AGENT_IMAGE` always overrides auto-detection.

### Scoping verification to the diff

A verification command scoped by a hand-maintained keyword filter (`pytest -k`) can silently exclude the file a worker actually changed: the same failure mode `verify_regression`/`testSelectionRisk` exist to catch. nomArmy exposes what the diff touched as two env vars inside the sandbox, language-agnostically:

| Variable | Contents |
|---|---|
| `NOMARMY_CHANGED_TEST_FILES` | New + modified test files, space-separated |
| `NOMARMY_CHANGED_PRODUCTION_FILES` | Non-test files touched, space-separated |

Both are always present (empty when nothing applies); a command that never references them is unaffected.

```yaml
verification:
  python:
    commands:
      - 'if [ -n "$NOMARMY_CHANGED_TEST_FILES" ]; then python3 -m pytest $NOMARMY_CHANGED_TEST_FILES -q; fi'
      - 'if [ -n "$NOMARMY_CHANGED_PRODUCTION_FILES" ]; then python3 -m pytest lambda/tests/ -k "gx or descriptor" -q; fi'
```

Run the narrow, touched-files pass for a fast/sharp signal *and* the broad pass whenever production changed: never one instead of the other; a shared module can have far more dependents than whichever file the diff happened to touch. Use `if`/`fi`, not `A && B || C` (a failing `B` there falls through to `C`'s exit code: a real false-pass bug caught in this project's own docs). For the *cost* of running the broad sweep twice under `verify_regression`, parallelism (`pytest-xdist -n auto`) beats scoping, since it doesn't trade away coverage.

### Catching a new function wired to nothing

A worker can introduce a new function/class that nothing outside its own test calls: built, never wired in. nomArmy finds definitions genuinely new in a diff (line-level, so a file full of already-used helpers doesn't flood this with noise) and flags any with zero non-test references anywhere in the repo. Heuristic and review-only, never a block: a dynamically-dispatched caller can look like this too.

## Other coordinators: Codex and Cursor

```bash
nomarmy connect claude codex cursor   # any subset
nomarmy connect                       # interactive multi-select
```

Codex reads `AGENTS.md`; Cursor's registration is a JSON file nomArmy edits directly. Each target is attempted independently. `nomarmy update` resyncs whichever are already connected.

## How nomArmy works (and why)

**Worker output is a claim. Repository and environment state are evidence.** The worker never runs Git, can't commit or mark its own work accepted, and writes a four-line report nomArmy checks against the repository rather than trusting. A malformed report isn't automatically a failure; if the repository changed, nomArmy verifies independently and may recover it. But **failing verification stays failed**, unconditionally.

**The economics**: use scarce frontier intelligence for intent and judgment, abundant worker intelligence for implementation and repair. Measured so far (`docs/experiments/2026-09-20-model-bakeoff-and-economics.md`): it depends on task size, not model choice. Small, precisely-diagnosed fixes lose to doing them yourself; delegation pays off when the surrounding context needed is meaningfully larger than the fix itself. A same-ticket comparison against a hosted model put local at $0/62s vs. ~$0.05-0.07/51s, real at scale but not proven as a universal curve. Local also means the model behind the seat can improve with your hardware, with nothing else in the harness changing.

A sharp corollary from real use: writing the coordinator's `evidence` field thoroughly enough to hand a worker every fact it needs *is* the diagnosis. If what's left after that is a small, mechanical change, you already paid the cost delegation exists to save, and the fix has quietly become the losing shape above. A ticket that's part diagnosed-fix and part bulk, mechanically-verified work (writing a batch of tests, say) usually splits better than it delegates whole: keep the fix, hand off only the part that's genuinely nom-shaped.

Two more findings from that same session, recounted carefully after separating a harness bug (since fixed) from what the models actually did. First: briefing a worker against code with no reachable test path at all (a function that can't even be imported without cloud credentials configured) produces exactly the failure it looks like it should, burning its whole budget hunting for a harness that doesn't exist. That's a briefing error, not a cheap-tier limit; the same work went smoothly once moved to a layer a test could actually reach. Second, and separately: 3 of 5 real completions that night shipped a test that passed whether or not the feature existed, the same inert-test defect `verify_regression`/`testSelectionRisk` above exist to catch. It's briefable: one paragraph naming that specific failure mode took an identical job, same base, same brief otherwise, from 1-of-3 inert tests to 3-of-3 real, for a measured +5 seconds.

**Scouts and decomposers** are read-only noms for research and planning: every claim carries a `[path:start-end]` citation, resolved against the exact base commit through Git, never the worktree. Most scout-shaped questions ("where is X defined") aren't questions for a model at all: `repo_evidence` answers them deterministically in milliseconds; reach for a nom only for what that can't answer.

**A concrete result**: a local 20B worker was asked to add a `doctor` command with tests. It produced 156 lines that read as competent (JSDoc throughout, clean structure) with six real defects invisible without executing it, including a file that didn't even parse and a "no test file" gap despite an explicit acceptance criterion. nomArmy committed nothing; the record showed `tests added: 0`, from the repository, not the worker's claim. That's the whole argument: reading the diff would have plausibly approved it; executing it didn't.

## Status

Bounded-delegation core is proven: coordinator-owned Git, isolated worktrees, retained failed worktrees. This release (`0.1.0-alpha`) extends toward autonomous workers with real execution environments: still in development.

| Capability | Status |
|---|---|
| Bounded delegation, coordinator-owned Git, retained worktrees | Working, E2E tested |
| Local (llama.cpp) and Amazon Bedrock execution profiles | Working |
| `nomarmy doctor` | Working, verified on a real host |
| Scout / decompose modes | Built, unit + live tested |
| `auto_union`, `verify_regression`, independent verification | Built, unit tested. `verify_regression` defaults ON whenever `verification` is set |
| Scoped test-selection risk / unwired-definition checks | Built, unit + live tested. Heuristic, review-only |
| Secret scanning (secretlint-backed, hard block) | Built, unit tested against the real dependency. Known secret shapes only, not steered content |
| `.nomarmy.yml` environment contract | Built, unit tested |
| Disposable per-job service environments (Postgres, mocks) | Not built |
| Nom-local browser/E2E, autonomous repair loop | Not built |
| Full-stack thesis test | 7 tickets across 3 local models: task-size-dependent, not unconditionally true. A separate adversarial single-night run initially scored 2 clean of 7; recounted after excluding 2 jobs an idle-diff harness bug (since fixed) had killed, it was 5 clean of 5, with per-job corrections trending to zero as the brief improved, not the model. See [How nomArmy works](#how-nomarmy-works-and-why) for what actually survived that recount |
| Swapping the active local model | Working |
| Go/Rust target repos | Verification live-verified; worker's own tool execution uses one global sandbox config |
| Agents (`agents.yml`): api keys | Live-verified for `xai`; other providers unverified against real keys |
| Agents: individual subscriptions | Claude live-verified end to end; OpenAI (Codex) test call confirmed; Meta Muse Code wired, not yet live-verified |
| The army (roles, the General, layers) | Unit- and CLI-tested; not yet driven by a real coordinator session |

Known limitations: verification profiles needing services beyond `environment: none` report `not_run` rather than executing without them; the environment scanner's Compose parser doesn't resolve YAML anchors/aliases.

## The MCP tools

Every job takes the same shape: a `task`, optional `acceptance`, a `mode`, a timeout.

| Tool | What it does |
|---|---|
| `local_worker` | Run one job and wait. |
| `local_worker_start` / `local_worker_status` | Start in the background / poll for the result. |
| `local_worker_capacity` | Context, budgets, memory pressure, what's running. Read-only. |
| `repo_evidence` | Deterministic evidence (definitions, references, outline, grep, files), `[path:line]` on every hit, no model. |
| `local_workers` | Run a batch with bounded parallelism. `auto_union: true` merges independent jobs into one integration branch for review. |
| `local_worker_jobs` | Recent job records: compact projection by default, `full: true` for the complete manifest. |
| `local_worker_cleanup` | Remove one worktree/branch. Recognizes a cherry-picked branch as integrated by content, not just ancestry. |
| `local_worker_sweep` | Bulk-reap worktrees that are provably empty (zero commits, nothing uncommitted), any age. `dry_run` previews. |
| `local_worker_config` | Surface `.nomarmy.yml`'s verification profiles. |
| `run_start` / `run_status` / `run_finish` | A `/feature` run: its limits, what it has used per agent, warnings, paused agents, and its log. |
| `army` | The General's charter and agent, then this repo's roles: descriptions, phases, each role's agent, which layer set it, and overlaps with the General. |

**Admission**: context-per-nom bounds brief/report size; free memory bounds whether a new job starts at all. The local model keeps its calibrated caps (a 3,000-character brief, 6,000 characters of evidence, a 512-token implement report), measured on a ~20B model where longer briefs made it thrash. An api or subscription agent gets frontier ceilings that scale with its model's context: up to a 16,000-character brief and 24,000 characters of evidence. A job's `report` (`brief`, `standard`, `full`) sets how much comes back, up to about 2k tokens for an implement job and 4k for a scout; the report lands in the coordinator's own context, so it's the coordinator's call per job.

## Security posture

The worker gets a writable worktree inside Podman and nothing else: no socket, no host credentials, no network. Repository content is untrusted input; `.nomarmy.yml` is data to validate, never authority.

**Never hand the coder** AWS/production credentials, deployment access, SSH keys, Kubernetes contexts, or Terraform state.

On Bedrock profiles, the model call is made by the host-side OpenClaw process, never from inside the sandbox, which stays `network: none` regardless. What changes on a cloud profile is data flow (repository content leaves the machine), not sandbox reach. A subscription-backed worker (Claude, OpenAI Codex) is the same split -- OpenClaw calls the model host-side, reading a local CLI's own already-authenticated session, never inside the sandbox -- with one addition: `on_behalf_of` is a self-reported attestation, not an independently verified identity check (see `SECURITY.md`).

Every diff and worker report is scanned for known secret shapes (secretlint's recommended preset: AWS, GitHub, Slack, Stripe, OpenAI/Anthropic, npm, private keys, and more) before a commit is allowed; a match blocks it. This catches known shapes, not adversarially steered content with no recognizable shape: see `SECURITY.md`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No API key found for provider "llama-cpp"` during `e2e.sh` | `./scripts/configure-openclaw.sh <profile>`, rerun. |
| `git worktree add` fails with `Filename too long` (Windows/WSL2) | `git config --global core.longpaths true`. |
| A config change didn't take effect | `nomarmy stop && nomarmy start`. |
| Verification always fails on a missing package | See `resolveNodeModulesMount` in `lib/verify.mjs` for Node's read-only `node_modules` mount. |
| Not sure a setting fits your hardware | `nomarmy sizing`, or `--check` against a loaded profile. |
| General "is this host ready" | `nomarmy doctor`. |

## Other notes

nomArmy is a same-host worker/coordinator stack today: MCP and OpenClaw run on the same machine. A centralized/remote-worker release doesn't exist yet.

Config vars are `NOMARMY_*`; a legacy `RAYSON_*` export is translated once at load with a deprecation warning.
