<h1 align="center"><img src="https://raw.githubusercontent.com/rayson-tech/nomarmy/main/nomarmy-logo.png" alt="nomArmy" width="320"></h1>

<p align="center">
  <a href="https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml"><img src="https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/nomarmy"><img src="https://img.shields.io/npm/v/nomarmy/alpha?label=npm%40alpha" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

<p align="center"><em>Tiny coders, big appetites for bounded tickets.</em> 🍪</p>

**Your coding assistant plans; sandboxed workers build; nothing counts until nomArmy has checked it.**

## TL;DR

1. **Have** Git, Node 20+ and [Podman](https://podman.io) (on macOS: `brew install podman && podman machine init && podman machine start`).
2. **Install** (OpenClaw and the sandbox, and registers nomArmy with Claude Code):
   ```bash
   git clone https://github.com/rayson-tech/nomarmy.git && cd nomarmy
   npm install && npm link
   nomarmy setup --hosted
   ./install.sh --profile hosted
   ```
3. **Add your workers:** `nomarmy agents add` (an API key, or your ChatGPT or Muse Code subscription), then `nomarmy army init --agent <name>` to put every role on it. `nomarmy doctor` checks the lot.
4. **Set up your repo:** in the project, run `nomarmy init`. It proposes a `.nomarmy.yml` with your test command.
5. **Use it:** restart Claude Code in that project and ask it to use nomArmy for one small bug that has a test. When that works, try `/feature <what you want built>`.

**Have a GPU or a Mac with plenty of memory?** Workers can also run free on a local model: `./install.sh --profile macbook-pro` (or `nvidia-linux`, `cpu-linux`, `dgx-spark`) builds llama.cpp and starts it; see [Install](#install). A team GPU server works too: [a shared model server](#a-shared-model-server). Codex or Cursor as the coordinator: `nomarmy connect codex cursor`.

Stuck? `nomarmy doctor` checks the machine, and `nomarmy health` checks everything nomArmy runs on.

## What it is

Your coding assistant (Claude Code, Codex or Cursor) stays in charge as the **General**: it decides what gets built and whether the result is acceptable. The work goes to **noms**, workers that implement, test and repair in their own git worktree and sandbox, on an API key, your own ChatGPT or Muse Code subscription, or a local model. nomArmy owns everything in between: worktrees, git, sandboxes, verification, and the evidence that decides whether work is accepted.

**What you get is work you don't have to take on faith**, not cheaper work. Delegating costs the General tokens too: briefing and reviewing. On small, already-diagnosed tickets we measured 4 to 8 times more of the General's tokens than fixing the bug directly, and break-even at roughly 150 lines of context a fix needs to read ([the measurements](docs/experiments/2026-09-20-model-bakeoff-and-economics.md)). It pays off on bigger tickets, on parallel work, and anywhere you'd otherwise have to trust an agent's say-so.

Developed and maintained by Rayson Technologies. This is an alpha (`0.1.0-alpha`).

## How it works

1. The General briefs a job: a task, acceptance criteria, the tests that prove it.
2. nomArmy creates a worktree from your branch and runs the worker in a Podman sandbox with no network and no host credentials. (One exception, the Claude subscription: see [Security posture](#security-posture).)
3. The worker edits, runs tests, and ends with a four-line report: `STATUS`, `TESTS`, `NOT_DONE`, `NOTE`.
4. nomArmy treats that report as a claim. It reads the real diff from git, runs your verification profile itself in a fresh sandbox, reverts the production change to check the tests actually fail without it, and scans for secrets.
5. Only then does it commit, on the worker's own branch. It never merges into yours: reviewing and integrating stay with the General, and with you.

A malformed report isn't automatically a failure: if the repository changed, nomArmy verifies independently and may recover the work. Failing verification stays failed, unconditionally. And the checks aren't the General's to waive: a repo's `.nomarmy.yml` policy (on by default for new repos) makes verification and the revert check mandatory for every job.

Around that core: **agents** say where a job can run, the **army** says which role runs on which agent, and **`/feature`** runs a whole feature end to end, from plan through build, review and acceptance, handing you a branch to merge.

## Install

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

**From npm:** `npm install -g nomarmy@alpha` gives you the `nomarmy` command; `nomarmy setup` then picks a profile and model and prints the `install.sh` command to run (`nomarmy setup --hosted` or `--llama-url <server>` without a local model). Installing from a clone, as in the TL;DR, is the most tested path.

### Hosted workers only

No GPU and no local model: every job runs on an API key or a subscription (ChatGPT, Muse Code) you add as an agent. Git worktrees, the sandbox and verification still run on your machine, so you still need Git, Node and Podman.

```bash
git clone https://github.com/rayson-tech/nomarmy.git && cd nomarmy
npm install && npm link              # or: npm install -g nomarmy@alpha
nomarmy setup --hosted               # records that this install has no local model
./install.sh --profile hosted        # OpenClaw, the sandbox, and the Claude Code registration; no llama.cpp
nomarmy agents add                   # an API key or a subscription login
nomarmy army init --agent <name>     # every role on that agent (add --model <model> to pick one)
nomarmy doctor
```

A hosted install refuses a job that names no role or agent, rather than falling back to a local model that isn't there. `nomarmy health` warns about any role still on `local`. `e2e.sh` tests the local model, so it has nothing to do here; `nomarmy army assign` tests each role's route instead.

### macOS (Apple Silicon)

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

### Linux

`install.sh` installs the toolchain, CMake, Git and Node when they're missing. Install Podman yourself first (`apt`, `dnf`, `zypper`, `pacman` or `apk install podman`).

```bash
# no NVIDIA GPU
./install.sh --profile cpu-linux --no-claude && ./e2e.sh --profile cpu-linux

# an NVIDIA GPU (not a DGX Spark: see below)
./install.sh --profile nvidia-linux --no-claude && ./e2e.sh --profile nvidia-linux
```

CPU-only Linux works but is slow for interactive use: see [Sizing](#sizing).

### Windows

`install.sh` doesn't run natively. In order of preference:

1. **WSL2** (the supported path): install a Linux distro under WSL2, install Podman inside it, and follow the [Linux](#linux) guide entirely inside the distro. Watch WSL2's default cap of about half your RAM (`.wslconfig`), and set `git config --global core.longpaths true` (`nomarmy doctor` checks this).
2. **Native llama.cpp on Windows**, built from source: more RAM, more setup. Prebuilt binaries aren't a safe shortcut; some CPUs crash every backend at startup.
3. **No local inference**: [hosted workers only](#hosted-workers-only), or [Bedrock](#cloud-bedrock).

`nomarmy sizing` reports what your hardware can support.

### DGX Spark

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
chmod +x install.sh e2e.sh scripts/*.sh
./install.sh --profile dgx-spark --no-claude
./e2e.sh --profile dgx-spark
```

Moving from a Mac install? Don't copy a Mac binary or model cache over: clone fresh and let `install.sh` build llama.cpp for CUDA on that machine.

### A shared model server

A team GPU box (a DGX, a workstation) runs one llama-server; everyone else points nomArmy at it. That works through an SSH tunnel too (`ssh -L 8080:localhost:8080 gpu-box`, then `http://127.0.0.1:8080`).

```bash
nomarmy setup --llama-url http://gpu-box:8080   # checks /health, records the address
./install.sh --profile remote                   # no llama.cpp build; OpenClaw points at that server
./e2e.sh --profile remote
```

nomArmy doesn't start, stop or size that server: whoever runs it sets its model, context and slots, and `install.sh` reads the model name and context from the server. Your machine still runs the sandbox and verification for your jobs. Several people sharing one server share its slots, so keep `NOMARMY_MAX_WORKERS` low (the profile sets 1). Run the server itself with any local profile's `install.sh` on the GPU machine, with `NOMARMY_LLAMA_HOST=0.0.0.0` so others can reach it, on a network you trust: llama-server has no authentication.

### Cloud (Bedrock)

No GPU, no local build:

```bash
export AWS_BEARER_TOKEN_BEDROCK=...   # or configure an AWS profile
./install.sh --profile bedrock
./e2e.sh --profile bedrock
```

Enable the models you intend to use in the Bedrock console first. `bedrock-cheap` runs the coordinator on the same open-weight model as the workers: real savings, a materially weaker guarantee (see `policies/reviewer.md`).

## Agents: where a job can run

`~/.config/nomarmy/agents.yml` (or `$NOMARMY_CONFIG_DIR`) lists every account a job can run on. An api or subscription agent is the **account**, not a model: the model is chosen per role or per job, and a `model` on the agent is only an optional default.

| Kind | What it is | Set up with |
|---|---|---|
| `local` | Your local llama-server model. `local` is built in; define another with `slot: gpt` for a second loaded model (see `config/agents.yml.example`) | nothing |
| `api` | A metered API key: `xai`, `openai`, `anthropic`, `deepinfra`, `bedrock`, `azure-openai`, `openai-compatible` (with `base_url`), or `openclaw` for any other OpenClaw provider by id | `nomarmy agents add api` |
| `subscription` | **One person's own** Claude, ChatGPT or Muse Code plan. Never pooled; every job on it names its owner. A Claude subscription's tools run on your machine, so it's for scouts and reviews unless you allow more (see [Security posture](#security-posture)) | `nomarmy agents add subscription claude\|codex\|meta` |

```bash
nomarmy agents add                  # asks which kind, then walks through it
nomarmy agents list                 # each agent, and which roles use it
nomarmy agents update codex --max-concurrent 3
```

`agents add` does the whole setup and asks only when something needs you:

- **An api agent**: it registers the key with OpenClaw over stdin, typed once or read from an environment variable you name, and makes a test call. `agents.yml` only ever holds the variable's *name*.
- **A subscription**: it installs the vendor's CLI if it's missing, runs that CLI's login, installs the OpenClaw plugin the vendor needs, lists the models your plan can use, defaults the owner to the account you logged in as, and makes a real test call before saving. For Meta it also copies the key Muse Code's login stored in your macOS keychain into OpenClaw (only that auto-connected key is flat-rate, per Meta's docs), and adds Meta's provider entry to OpenClaw's config.

nomArmy starts each login; the vendor's CLI and OpenClaw do the authenticating.

```yaml
# ~/.config/nomarmy/agents.yml   (see config/agents.yml.example)
agents:
  claude: { kind: subscription, provider: claude-cli, owner: you@example.com }
  codex:  { kind: subscription, provider: openai, owner: you@example.com, max_concurrent: 3 }
  grok:   { kind: api, provider: xai, auth_env: NOMARMY_XAI_API_KEY, thinking: high }
```

**Which model runs**, first to last: the job's own `model` (the General's choice), then the role's model unless it's `auto`, then the agent's default. No model at all is refused, never guessed, and nothing picks between agents at random. A job with no role and no agent runs on `local`.

**Settings**:
- `max_concurrent`: how many jobs run on this agent at once, counted across every session on the machine. Defaults are 1 for a subscription and 2 for an api key; raising it spends your plan's usage limits faster. Api and subscription jobs together are also capped by `NOMARMY_MAX_POOL_WORKERS` (default 4), separately from local workers.
- `thinking`: `true` follows the job's level, `false` is off, or a fixed `low`, `medium` or `high`.
- `context_window`: overrides OpenClaw's catalog for a model newer than it knows.

Changes apply to the next job with no restart. The exception is a **new** api agent, which needs one `nomarmy connect claude` so the MCP server sees its key variable (`agents add` offers to do it).

**Why subscriptions are individual, never pooled.** Anthropic's terms separate "individual experimentation and automation" (sanctioned, including third-party apps through the Agent SDK, per seat and non-transferable) from "teams running shared production automation" (use the metered API). So a subscription agent belongs to one named person, a job on it must say `on_behalf_of: "<owner>"` or it's refused, and nothing ever load-balances across subscriptions. xAI subscriptions are out of scope until its terms are clear; an xAI API key is fine.

**One credential per provider id.** OpenAI, Meta and xAI keep a subscription and an API key under the same OpenClaw provider id, so `agents.yml` refuses an api agent and a subscription agent on the same one. Claude never collides: its subscription is `claude-cli`, its API key `anthropic`. A ChatGPT plan runs as `openai/<model>` through the Codex login.

**Your plan decides which models run.** A model can be listed and still refused: on a ChatGPT plan, the Codex route runs gpt-6-astra and the gpt-5.6 models but refuses gpt-6-sol and gpt-6-luna. `army assign` and `agents update --probe` test the exact route a job takes, so they catch this before a job does.

**Vendor terms and platform risk.** Every model call goes through [OpenClaw](https://github.com/openclaw/openclaw), and subscriptions are reached through each vendor's own CLI or login. We've read the terms that apply (see above), but using a personal subscription through a harness is exactly the kind of use vendors tighten, and a change in a vendor's terms or in OpenClaw can stop a subscription agent from working. Local models and API keys don't carry that risk. Plan on subscriptions as a convenience, not the only way your roles can run.

**Picking an agent.** Build work goes to a sandboxed agent: `local`, an api key, Codex or Muse. `local` for a bounded change against a written spec with a test; your code never leaves your machine. An api or subscription agent when the work needs more than the local model, knowing it sends code to that vendor. That's a decision about where your source travels, separate from the trust boundary, which is the same for every agent. The General itself when the answer isn't known yet.

## The army: who does what

The **General** is your coordinator session. Its charter is fixed by nomArmy: it plans and decomposes, makes architecture and security decisions, briefs and dispatches each role, reviews every result against nomArmy's verified record, owns git and integration, and gives final acceptance. It runs outside every sandbox and is never dispatched to. What you define is which agent it is:

```bash
nomarmy army general claude     # the agent for your own Claude seat
```

That lets nomArmy flag a role that runs on the General's own agent (a review that isn't independent) or on the same subscription (the same usage limit).

Every other role is yours: a name, when the General calls it, a phase, and the agent it runs on.

```bash
nomarmy army init                                             # the default roster
nomarmy army assign sr-dev codex gpt-6-astra                  # an agent and a model
nomarmy army assign pm codex auto                             # the General picks the model per job
nomarmy army assign ui-ux codex gpt-6-astra --project         # this repo, committed
nomarmy army assign security-analyst grok grok-4.7 --local    # just you, just this repo
nomarmy army show                                             # the General, the roster, and who set what
```

`army assign` makes a real test call on the job's route before it saves, and refuses a model that doesn't run.

The default roster follows a normal delivery cycle. The **Sr Dev** does the first cut and keeps the harder implementation, handing simple, well-specified work to **Jr Devs**; **UI/UX** gets UI work. Once the build is done, the specialists who apply review it (**data architect** for star schema and medallion design, **security analyst**), the **PM** reviews against the plan, and the **PO** and **stakeholders** test end to end. Not every role runs every time. Every role starts on `local`.

A job dispatches with `army_role: "security-analyst"`: nomArmy runs it on that role's agent and opens the brief with the role's description. The General reads the whole roster through the read-only `army` MCP tool.

**Config layers**, merged like Claude Code's settings (later wins, field by field):

| Layer | File | Committed | Holds |
|---|---|---|---|
| global | `~/.config/nomarmy/config.yml` | no | your default army, your General, your run limits |
| project | `<repo>/.nomarmy.yml` (`army:`, beside `verification:`) | yes | the team's roles for this repo (never the General) |
| local | `<repo>/.nomarmy.local.yml` | no; a tracked copy is refused | your overrides for this repo |

An army section can only **name agents**. It has no field for a credential, endpoint, owner or provider, so a hostile `.nomarmy.yml` in a cloned repo can at worst route a job to one of your own agents. It's also why a project file uses generic agent names (`codex`, not `jason-codex`): each teammate defines an agent by that name on their own login.

**Shared machines** (a team DGX Spark): give each person their own OS account. Subscription logins live in that account's home directory and keychain, never in a nomArmy file, so each person's coordinator only reaches their own subscriptions, and nomArmy refuses an `agents.yml` another account owns or can write. One OS account shared by several people is the pooling this design exists to prevent, and `on_behalf_of` can't detect it.

## `/feature`: a feature, end to end

```
/feature add join partners to the schema context
```

The General runs the army's whole workflow on its own and comes back when it's done: a plan, the build (Sr Dev, Jr Dev, UI/UX), the reviews that apply (data architect, security analyst, then the PM against the plan) and acceptance (PO, stakeholder), sending fixes back to the builders along the way. It ends with **a branch for you to review and merge**. nomArmy never merges or pushes, and never deploys or touches cloud credentials; those are hard stops. Any other decision it would normally ask you about, it makes conservatively, records, and keeps going, and every such decision is in the final report.

`nomarmy connect` installs it: `/feature` in Claude Code, a `nomarmy-feature` skill in Codex, and `/feature` in Cursor (Cursor's path follows its documentation and hasn't been tested against a real install). A command of your own with the same name is never overwritten.

**Limits.** Each feature is a *run* (`run_start`), and its jobs join it automatically. Admission enforces the run's limits and warns at 80%:

```yaml
# ~/.config/nomarmy/config.yml (or .nomarmy.local.yml; never the committed .nomarmy.yml)
army:
  run_limits:
    max_jobs: 40        # the defaults
    max_api_usd: 10     # api agents only; a subscription isn't billed per call
    max_hours: 6
    warn_at: 0.8
```

The General can lower these for one run, never raise them. When a vendor answers with a usage-limit error, that agent is paused for the rest of the run and the General stops and tells you; it never moves the role to another vendor to get around it. The one limit no tool can see is your coordinator's own seat. If that runs out mid-feature, the run log (kept current after every phase) lets `/feature resume <run-id>` in a fresh session carry on.

## Watching what nomArmy is doing

- **Claude Code's status line** shows what's running in this repo, a count for other repos, the open run, and the most serious health warning: `Opus 5.5 · rayson-senti │ 🍪 2: sr-dev codex 9m 10f · scout grok 1m │ run 3/14 $0.41`. `nomarmy connect claude` installs it unless you have your own; then `nomarmy statusline` prints nomArmy's part for you to add.
- **Desktop notifications** when a job finishes, a run crosses a limit or pauses an agent, or a health check finds a new problem. They come from nomArmy itself, so they work with any coordinator; on macOS they carry nomArmy's icon. `NOMARMY_NOTIFY=0` turns them off.
- **`nomarmy jobs --watch`** is a live table; **`nomarmy jobs --events`** prints one line per job start, phase change and finish, which the General watches in the background instead of polling.
- **`run_status`** lists a run's running and finished jobs, with each one's phase, last tool call and files changed so far.
- **Health checks** run a minute after each server starts and every 6 hours after that: logins about to expire, OpenClaw and plugin versions, roles that can't run, providers missing from OpenClaw's config, models refused on a real job, and storage. `nomarmy health` runs them now.

**Storage** looks after itself. OpenClaw's scratch files (about 1.2 GB for a Codex job) go when each call ends, and each health check removes finished jobs' remaining runtime data after a day (`NOMARMY_AUTO_PRUNE_HOURS`, `0` to turn it off), keeping every job's record and report. `nomarmy jobs --prune --older-than 0` does it for every finished job now.

## Your repository

### `.nomarmy.yml`

A repo's execution contract: its verification profiles and, optionally, its army and dependency settings. `nomarmy init` proposes one from what it finds (compose files, CI steps, requirements files, test commands) and writes it only after you confirm. nomArmy reads it from your checkout, never from a job's worktree, so a worker can't weaken its own checks.

```yaml
verification:
  quick:
    environment: none
    commands:
      - npm test
```

`nomarmy validate` checks the file against the schema; `nomarmy scan --check` diffs it against what the repo actually contains.

**Policy: what no job can skip.**

```yaml
policy:
  require_verification: true       # every implement job needs a verification profile; only passing work commits
  require_regression_check: true   # verify_regression can't be switched off per job
```

`nomarmy init` proposes both for new repos. Without them, a job with no verification profile still commits (flagged for review, not blocked), and the General decides per job whether to run the revert check. With them, those are the repo's rules, not the General's judgment calls, and since nomArmy reads this file only from your checkout, neither the General nor a worker can relax it.

**Refactors.** Reverting a behavior-preserving change restores code that works, so the revert check can't prove anything about it. A job can declare `refactor: true` instead: nomArmy then commits it only if verification passes **and no test file was added, changed or deleted**. The existing tests passing unchanged is the evidence. A change that alters behavior has to alter tests to show it, so it can't pass as a refactor.

**Add a check for what unit tests can't see.** A module left out of a deploy bundle passes every unit test and crashes at deploy. When `nomarmy init` sees a bundle or packaging step (Lambda asset scripts, SAM, Serverless, CDK), it suggests a profile that runs it and then imports each entry point from the built bundle.

### Languages and dependencies

The sandbox has no network, so dependencies are installed when its image is built, on your machine, and the image is cached by a hash of the dependency files.

| Repo | Detected by | Sandbox |
|---|---|---|
| Node | every package with its own `package-lock.json` or `npm-shrinkwrap.json`: the root, and any others (a `ui/`, a `lambda/api/`) | `npm ci` for each at build time, under `/deps` at the same path. The root's packages are at `/node_modules`; each other package gets a `node_modules` link into the image, which nomArmy never commits |
| Python | `requirements.txt`, or `environment.python.requirements` | `pip install` at build time |
| Both | both of the above | one image with both |
| Go, Rust | `go.mod`, `Cargo.toml` | the toolchain, built once and cached |
| anything else | | the base image: Node, Python 3, git, ripgrep |

The worker's own tool calls and nomArmy's verification use the same image. `NOMARMY_AGENT_IMAGE` overrides detection, and `environment.node.install: false` turns the Node install off.

```yaml
environment:
  python:
    requirements:
      - requirements-dev.txt
      - lambda/requirements.txt
```

A package whose install fails (a private registry, say) is marked and skipped; the rest still install. npm workspaces, yarn, pnpm and bun aren't installed yet. For those repos, verification borrows your own checkout's `node_modules` read-only, which works for plain JavaScript packages but not for ones with native binaries built for your host.

### Scoping verification to the diff

A command scoped by a hand-maintained filter (`pytest -k`) can silently skip the file a worker changed. Every verification command gets two variables to scope by instead:

| Variable | Contents |
|---|---|
| `NOMARMY_CHANGED_TEST_FILES` | New and modified test files, space-separated |
| `NOMARMY_CHANGED_PRODUCTION_FILES` | Non-test files touched, space-separated |

```yaml
verification:
  python:
    commands:
      - 'if [ -n "$NOMARMY_CHANGED_TEST_FILES" ]; then python3 -m pytest $NOMARMY_CHANGED_TEST_FILES -q; fi'
      - 'if [ -n "$NOMARMY_CHANGED_PRODUCTION_FILES" ]; then python3 -m pytest lambda/tests/ -q; fi'
```

Run the narrow pass on the touched files for a fast, sharp signal, *and* the broad pass whenever production code changed: a shared module can have far more dependents than the files a diff happens to touch. Running the changed tests on their own also catches a test that only passes inside the full suite.

### What else nomArmy checks

- **Tests that prove nothing.** With `verify_regression` (on whenever a job has a verification profile), nomArmy reverts the production change and re-runs the tests: a test that still passes is flagged.
- **Tests made to pass.** New skip markers, stubbed imports, fake modules named like a dependency, and stray backup files are flagged for review.
- **Code wired to nothing.** A new function or class that nothing outside its own test calls is flagged (heuristic and review-only).
- **Secrets.** Every diff and report is scanned for known secret shapes (secretlint's recommended preset) before a commit is allowed; a match blocks it.

## Configuration

Local inference is configured in two files, and a shell-exported variable overrides both. Every variable is documented where it's set.

- **`config/common.env`**: defaults shared by every profile.
- **`config/profiles/<name>.env`**: per-machine overrides (context size, GPU layers, threads, workers).

| Variable | Lives in | Default | Controls |
|---|---|---|---|
| `NOMARMY_WORKER_MODEL` | common.env | `gpt-oss-20b` | Which local model runs jobs |
| `NOMARMY_MODEL_REPO` / `_QUANT` | common.env | `ggml-org/gpt-oss-20b-GGUF` / `MXFP4` | Which GGUF to download |
| `NOMARMY_LLAMA_CONTEXT` | profile | `65536` | **Total** context across all slots |
| `NOMARMY_LLAMA_PARALLEL` | profile | `1` | Inference slots (the context is divided across them) |
| `NOMARMY_MAX_WORKERS` | profile | `1` | How many local jobs run at once |
| `NOMARMY_MAX_POOL_WORKERS` | environment | `4` | How many api and subscription jobs run at once |
| `NOMARMY_EXECUTION` | common.env | `local` | `local` or `bedrock` |
| `NOMARMY_ORCHESTRATOR_TRUST` | common.env | `frontier` | `frontier` or `degraded`: see `policies/reviewer.md` |

**The coupling that trips people up**: `NOMARMY_LLAMA_CONTEXT` is divided by `NOMARMY_LLAMA_PARALLEL`, not given to each slot whole. `65536` across 2 slots is `32768` per nom.

A change needs an inference restart: `nomarmy stop && nomarmy start` (logs go to `~/.local/share/nomarmy-local-agents/logs/`). `nomarmy config paths` shows where every config file lives.

### Swapping the local model

```bash
nomarmy model
```

It offers three measured choices (gpt-oss-20b, Qwen3-Coder-Next and Qwen3.6-27B: see the [model bake-off](docs/experiments/2026-09-20-model-bakeoff-and-economics.md)) or a Hugging Face search. It also offers to update the MCP registration and restart inference, since the config, the registration and the running model all need to agree.

### Sizing

Three coupled settings: `NOMARMY_LLAMA_CONTEXT` (total context), `NOMARMY_LLAMA_PARALLEL` (slots) and `NOMARMY_MAX_WORKERS` (concurrent local jobs). `nomarmy sizing` reads your hardware and the model's GGUF metadata, checks live memory pressure, and recommends a combination.

- **Aim for 64K context per nom.** An autonomous explore, implement, test and repair loop needs more room than a one-shot edit.
- **More noms isn't automatically faster.** On one Apple Silicon machine, 4 parallel local workers produced no more accepted work than 1. Measure before raising it.
- **Speed matters more than fit.** CPU-only inference measured about 3.8 tokens per second on a 20-core i7 (an 11.5-minute job for two turns). Use a GPU or a hosted agent for interactive work; CPU-only is a correctness testbed.

Advanced llama-server tuning (`NOMARMY_LLAMA_CACHE_TYPE_K/V`, `_FLASH_ATTN`, `_REASONING_BUDGET`, `_REASONING_PRESERVE`, `_EXTRA_ARGS`) is documented in `config/profiles/*.env`; all unset by default.

### Admission and budgets

A job is admitted only when there's context and memory for it, and briefs and reports are sized to the agent. The local model keeps caps calibrated on a 20B model, where longer briefs made it thrash: a 3,000-character brief, 6,000 characters of evidence, a 512-token implement report. An api or subscription agent gets ceilings that scale with its model's context, up to a 16,000-character brief and 24,000 characters of evidence. A job's `report` (`brief`, `standard`, `full`) sets how much comes back, up to about 2k tokens for an implement job and 4k for a scout. The report lands in the General's own context, so that's its call per job.

## Command reference

### The `nomarmy` CLI

Every command proposes before it writes: a `[y/N]` prompt, or an explicit flag under `--json`. All take `--json` and `--repo <dir>`.

| Command | What it does |
|---|---|
| `nomarmy doctor` | Checks this machine is ready, with a fix for anything missing. Start here. |
| `nomarmy setup` | Detects the machine, recommends a profile, picks a model, writes config. Prints (never runs) `install.sh`. |
| `nomarmy connect [claude] [codex] [cursor]` | Registers nomArmy with each coordinator and installs `/feature`, the status line and the notifier. No target: pick interactively. |
| `nomarmy init` | Proposes a `.nomarmy.yml` from what the repo contains. |
| `nomarmy agents list\|add\|update\|remove` | Where jobs can run. See [Agents](#agents-where-a-job-can-run). |
| `nomarmy army show\|init\|assign\|general` | The General and the roster. See [The army](#the-army-who-does-what). |
| `nomarmy jobs [--watch\|--events\|--prune]` | What's running across every session, and what just finished. |
| `nomarmy health` | Runs the health checks now. |
| `nomarmy statusline` | nomArmy's part of Claude Code's status line. |
| `nomarmy config paths` | Where each config file lives. |
| `nomarmy model` | Changes the local model. |
| `nomarmy sizing` | Recommends context, slots and workers. `--check` evaluates the loaded profile; `--noms N` sizes for a count. |
| `nomarmy start` / `stop` | Starts or stops local inference. |
| `nomarmy scan` | Reports the repo's execution environment. `--check` diffs it against `.nomarmy.yml`. |
| `nomarmy validate` | Validates `.nomarmy.yml`. |
| `nomarmy update` | From a clone: pulls (fast-forward only) and resyncs what each coordinator runs. From npm: tells you the npm command. |
| `nomarmy uninstall` | Removes the MCP registration and install. `--clear-agents`, `--clear-models` or `--all` go further. |

### MCP tools

What the General uses. Every job takes the same shape: a `task`, optional `acceptance`, a `mode` and a timeout.

| Tool | What it does |
|---|---|
| `local_worker` | Runs one job and waits for it. |
| `local_worker_start` / `local_worker_status` | Starts a job in the background / waits for its result. |
| `local_workers` | Runs a batch of independent jobs in parallel. `auto_union: true` merges them into one integration branch for review. |
| `repo_evidence` | Deterministic answers (definitions, references, outlines, grep, files) with `[path:line]` on every hit, no model. |
| `army` | The General's charter and agent, then this repo's roles and who runs each. |
| `run_start` / `run_status` / `run_finish` | A `/feature` run: its limits, usage per agent, warnings, paused agents and log. |
| `local_worker_capacity` | Context, budgets, memory pressure and what's running. |
| `local_worker_jobs` | Recent job records; `full: true` for the complete manifest. |
| `local_worker_config` | This repo's verification profiles. |
| `local_worker_cleanup` | Removes one worktree and branch. Recognizes a cherry-picked branch as integrated by content. |
| `local_worker_sweep` | Removes worktrees that are provably empty. `dry_run` previews. |

A job's `mode` is `implement` (edits, then nomArmy verifies and commits), `scout` (read-only research, every claim cited as `[path:start-end]` and checked against the base commit) or `decompose` (read-only, proposes independent subtasks for the General to dispatch).

## Security posture

The worker gets a writable worktree inside Podman and nothing else: no Podman socket, no host credentials, no network. Repository content is untrusted input, and `.nomarmy.yml` is data to validate, never authority.

**The exception: a Claude subscription runs its tools on your machine.** OpenClaw reaches a Claude plan by running the real `claude` command on the host, and Claude Code's own tools (Bash, Edit, Write) run there, with your files and the network, not in the sandbox. We checked each route by having a worker report where its shell ran:

| Agent | Its tools run |
|---|---|
| `local`, api keys (xAI, OpenAI, Anthropic, ...), ChatGPT via Codex, Muse Code | in the sandbox: Linux, `/workspace`, no network |
| Claude subscription (`claude-cli`) | **on this machine**: your real paths, with network |

So nomArmy refuses **implement** jobs on a Claude subscription unless that agent says `allow_host_tools: true` in `agents.yml`; scouts and reviews still run, labeled. `nomarmy health` and the `army` tool flag any build role on it, and `agents list` says so. If a job's worktree comes back with a real `node_modules` where nomArmy's dependency link was (packages installed where the sandbox couldn't have), nomArmy flags the job for review and verifies against the sandbox's own dependencies. Sandboxing the Claude route properly needs OpenClaw to run it with only OpenClaw's own (sandboxed) tools, which it supports internally but doesn't expose yet. An Anthropic **api key** runs through OpenClaw's own loop and is sandboxed like the rest.

**Never hand a worker** AWS or production credentials, deployment access, SSH keys, Kubernetes contexts or Terraform state.

Every model call, local, api or subscription, is made by OpenClaw on the host, never from inside the sandbox. A subscription is reached through the vendor's own logged-in session; nomArmy never reads or stores the token. What changes with a hosted agent or a Bedrock profile is where your code goes (to that vendor), not what the sandbox can reach.

`on_behalf_of` is a self-reported attestation, not a verified identity: nomArmy has no caller-identity boundary. The secret scan catches known secret shapes, not steered content with no recognizable shape. Both are covered in [SECURITY.md](SECURITY.md), which is also where to report a vulnerability.

## Status

| Capability | Status |
|---|---|
| Delegation core: worktrees, nomArmy-owned git, independent verification, kept failed worktrees | Working, end-to-end tested |
| Local (llama.cpp) and Bedrock profiles | Working |
| Scout and decompose modes | Unit and live tested |
| `auto_union`, `verify_regression`, test-selection and unwired-code checks | Unit and live tested; the heuristics are review flags |
| Secret scanning (secretlint, hard block) | Unit tested against the real dependency |
| Agents: api keys | Live-verified with xAI; other providers built to OpenClaw's documented interface |
| Agents: subscriptions | ChatGPT (Codex) and Muse Code sandboxed and live-verified; Claude live-verified, but its tools run on the host (scout and review by default) |
| The army and `/feature` | Driven by a real Claude Code General across three runs, about 18 implement jobs |
| Go, Rust, Python and Node repos | Dependency images live-verified for Python and Node (npm); Go and Rust toolchains live-verified |
| Disposable per-job services (Postgres, mocks) | Not built |
| Browser/E2E testing inside a nom | Not built |

What we've learned from real runs, including where delegating pays and where it doesn't, is in [docs/findings.md](docs/findings.md).

### Known limitations

- **A Claude subscription isn't sandboxed.** Its tools run on your machine, so implement jobs on it are refused unless you set `allow_host_tools: true`. See [Security posture](#security-posture).
- **A refused model costs one job.** When a vendor refuses a model at run time that OpenClaw lists (gpt-6-sol on a ChatGPT plan), the first job on it fails with `model_not_found`. After that nomArmy refuses to dispatch it until a job or test call on it works. `army assign` tests the job's route and catches this before any job.
- **Claude subscription token counts** come from the Claude CLI's own session log, since OpenClaw sees only the final reply. Totals include cache reads and writes, which make up most of an agent's prompt; each part is also kept separately.
- **Test-workaround detection is a flag, not a verdict**: a legitimate new skip still gets flagged.
- **Deploy-time failures need your own check.** See [Add a check for what unit tests can't see](#nomarmyyml).
- **Node dependencies install only from npm lockfiles**, one per package (no workspaces, yarn, pnpm or bun yet), and only from the public registry: the image build has no credentials for a private one.
- **Verification needing services** (a database, a mock server) reports `not_run` instead of running without them. The compose parser doesn't resolve YAML anchors.
- **Same-host sandboxes**: the MCP server, OpenClaw and every job's sandbox run on the machine with the coordinator. Only the model can be elsewhere (an agent, or [a shared model server](#a-shared-model-server)).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything unclear about the machine | `nomarmy doctor`, then `nomarmy health` |
| `No API key found for provider "llama-cpp"` during `e2e.sh` | `./scripts/configure-openclaw.sh <profile>`, then rerun |
| A job fails with `model_not_found` | Your plan or OpenClaw can't run that model. `nomarmy agents list` shows which roles use it; `nomarmy army assign <role> <agent> <model>` moves the role and tests the new model |
| Verification fails on a missing package | Node: commit each package's `package-lock.json` (yarn, pnpm and workspaces aren't installed yet). Python: list your requirements files under `environment.python.requirements` |
| A config change didn't take effect | `nomarmy stop && nomarmy start` for inference; restart your coordinator after `nomarmy connect` or an update |
| `git worktree add` fails with `Filename too long` (Windows/WSL2) | `git config --global core.longpaths true` |
| Not sure a setting fits your hardware | `nomarmy sizing`, or `nomarmy sizing --check` |

## More

- [docs/findings.md](docs/findings.md): what real runs taught us.
- [docs/experiments](docs/experiments): the measured write-ups behind them.
- [policies](policies): how scouts and reviewers are held to account.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Configuration variables are `NOMARMY_*`; a legacy `RAYSON_*` variable is translated once at load, with a deprecation warning.

Licensed under [Apache 2.0](LICENSE).
