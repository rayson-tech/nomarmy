<h1 align="center"><img src="https://raw.githubusercontent.com/rayson-tech/nomarmy/main/nomarmy-logo.png" alt="nomArmy" width="320"></h1>

<p align="center">
  <a href="https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml"><img src="https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/nomarmy"><img src="https://img.shields.io/npm/v/nomarmy/alpha?label=npm%40alpha" alt="npm"></a>
  <a href="https://github.com/rayson-tech/nomarmy/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

<p align="center"><em>Tiny coders, big appetites for bounded tickets.</em> 🍪</p>

**Your coding assistant plans; sandboxed workers build; nothing counts until nomArmy has checked it.**

## TL;DR

1. **Have** Git, Node 20+ and [Podman](https://podman.io) (on macOS: `brew install podman && podman machine init --memory 8192 && podman machine start`; Podman's 2 GiB default is too small for nomArmy's sandboxes).
2. **Install and set up:**
   ```bash
   npm install -g nomarmy@alpha
   cd your-project
   nomarmy setup
   ```
   `nomarmy setup` is the playbook. It shows a checklist and runs the next step each time you say yes:
   ```text
   ✓ Where models run: hosted
   ✓ Installed: OpenClaw 2026.9.6
   → Agents: add a hosted agent
     Roles: add an agent first
     This repo: configure this project
     Check: verify the installation
   Run `nomarmy agents add` now? [Y/n]
   ```
   In order: pick where models run (API keys and subscriptions for most people), install OpenClaw and the sandbox, add your agents (an API key, or your ChatGPT or Muse Code subscription), put the roles on them, write this repo's `.nomarmy.yml`, then check it all. Stop anytime; `nomarmy setup` picks up where you left off.

   **Want every step spelled out?** [Example setup: Claude Code, Codex and an API key](https://github.com/rayson-tech/nomarmy/blob/main/docs/setup/example.md) walks through a complete setup, command by command.
3. **Use it:** restart Claude Code in the project and ask it to use nomArmy for one small bug that has a test. When that works, try `/feature <what you want built>`.

**Have a GPU or a Mac with plenty of memory?** Choose "a local model" in `nomarmy setup` and workers run on llama.cpp on your own machine: no per-token bill and your code stays home, but you pay in hardware, power and speed, and a model too big for your memory crawls. `nomarmy sizing` tells you what fits; see [Install](https://github.com/rayson-tech/nomarmy/blob/main/docs/install.md#install). A team GPU server works too: [a shared model server](https://github.com/rayson-tech/nomarmy/blob/main/docs/install.md#a-shared-model-server). Codex or Cursor as the coordinator: `nomarmy connect codex cursor`.

Stuck? `nomarmy doctor` checks the machine, and `nomarmy health` checks everything nomArmy runs on.

## What it is

Your coding assistant (Claude Code, Codex or Cursor) stays in charge as the **General**: it decides what gets built and whether the result is acceptable. The work goes to **noms**, workers that implement, test and repair in their own git worktree and sandbox, on an API key, your own ChatGPT or Muse Code subscription, or a local model. nomArmy owns everything in between: worktrees, git, sandboxes, verification, and the evidence that decides whether work is accepted.

**What you get is work you don't have to take on faith**, not cheaper work. Delegating costs the General tokens too: briefing and reviewing. On small, already-diagnosed tickets we measured 4 to 8 times more of the General's tokens than fixing the bug directly, and break-even at roughly 150 lines of context a fix needs to read ([the measurements](https://github.com/rayson-tech/nomarmy/blob/main/docs/experiments/2026-09-20-model-bakeoff-and-economics.md)). It pays off on bigger tickets, on parallel work, and anywhere you'd otherwise have to trust an agent's say-so.

Developed and maintained by Rayson Technologies. This is an alpha (`0.1.0-alpha`).

## How it works

1. The General briefs a job: a task, acceptance criteria, the tests that prove it.
2. nomArmy creates a worktree from your branch and runs the worker in a Podman sandbox with no network and no host credentials. (One exception, the Claude subscription: see [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md#security-posture).)
3. The worker edits, runs tests, and ends with a four-line report: `STATUS`, `TESTS`, `NOT_DONE`, `NOTE`.
4. nomArmy treats that report as a claim. It reads the real diff from git, runs your verification profile itself in a fresh sandbox, reverts the production change to check the tests actually fail without it, and scans for secrets.
5. Only then does it commit, on the worker's own branch. It never merges into yours: reviewing and integrating stay with the General, and with you.

A malformed report isn't automatically a failure: if the repository changed, nomArmy verifies independently and may recover the work. Failing verification stays failed, unconditionally. And the checks aren't the General's to waive: a repo's `.nomarmy.yml` policy (on by default for new repos) makes verification and the revert check mandatory for every job.

Around that core: **agents** say where a job can run, the **army** says which role runs on which agent, and **`/feature`** runs a whole feature end to end, from plan through build, review and acceptance, handing you a branch to merge.

## Docs

| | |
|---|---|
| [Install](https://github.com/rayson-tech/nomarmy/blob/main/docs/install.md) | Every setup: hosted (API keys and subscriptions), a local model on macOS, Linux, Windows or DGX Spark, a shared model server, Bedrock |
| [Example setup](https://github.com/rayson-tech/nomarmy/blob/main/docs/setup/example.md) | Claude Code, Codex and an API key, command by command |
| [Agents and the army](https://github.com/rayson-tech/nomarmy/blob/main/docs/agents-and-army.md) | Where a job can run, who does what, usage limits, picking an agent |
| [`/feature` runs](https://github.com/rayson-tech/nomarmy/blob/main/docs/feature-runs.md) | A feature end to end, and watching what nomArmy is doing |
| [Your repository](https://github.com/rayson-tech/nomarmy/blob/main/docs/your-repo.md) | `.nomarmy.yml`, verification, languages and dependencies, what nomArmy checks |
| [Configuration](https://github.com/rayson-tech/nomarmy/blob/main/docs/configuration.md) | Settings, swapping the local model, sizing, admission |
| [Reference](https://github.com/rayson-tech/nomarmy/blob/main/docs/reference.md) | Every CLI command and MCP tool |
| [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md) | What the sandbox holds back, and the one exception |
| [Troubleshooting](https://github.com/rayson-tech/nomarmy/blob/main/docs/troubleshooting.md) | Symptoms and fixes |

## Security

A worker gets a writable git worktree inside a Podman sandbox and nothing else: no network, no host credentials, no Podman socket. Every model call is made by OpenClaw on your machine, never from inside the sandbox. **The exception is a Claude subscription**, whose tools run on your machine, so nomArmy refuses build jobs on it unless you allow it. Never hand a worker production credentials, deployment access or SSH keys. Details: [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md); to report a vulnerability, [SECURITY.md](https://github.com/rayson-tech/nomarmy/blob/main/SECURITY.md).

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

What we've learned from real runs, including where delegating pays and where it doesn't, is in [docs/findings.md](https://github.com/rayson-tech/nomarmy/blob/main/docs/findings.md).

### Known limitations

- **A Claude subscription isn't sandboxed.** Its tools run on your machine, so implement jobs on it are refused unless you set `allow_host_tools: true`. See [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md#security-posture).
- **A refused model costs one job.** When a vendor refuses a model at run time that OpenClaw lists (gpt-6-sol on a ChatGPT plan), the first job on it fails with `model_not_found`. After that nomArmy refuses to dispatch it until a job or test call on it works. `army assign` tests the job's route and catches this before any job.
- **Claude subscription token counts** come from the Claude CLI's own session log, since OpenClaw sees only the final reply. Totals include cache reads and writes, which make up most of an agent's prompt; each part is also kept separately.
- **Test-workaround detection is a flag, not a verdict**: a legitimate new skip still gets flagged.
- **Deploy-time failures need your own check.** See [Add a check for what unit tests can't see](https://github.com/rayson-tech/nomarmy/blob/main/docs/your-repo.md#nomarmyyml).
- **Node dependencies install only from npm lockfiles**, one per package (no workspaces, yarn, pnpm or bun yet), and only from the public registry: the image build has no credentials for a private one.
- **Verification needing services** (a database, a mock server) reports `not_run` instead of running without them. The compose parser doesn't resolve YAML anchors.
- **Same-host sandboxes**: the MCP server, OpenClaw and every job's sandbox run on the machine with the coordinator. Only the model can be elsewhere (an agent, or [a shared model server](https://github.com/rayson-tech/nomarmy/blob/main/docs/install.md#a-shared-model-server)).

## More

- [docs/findings.md](https://github.com/rayson-tech/nomarmy/blob/main/docs/findings.md): what real runs taught us.
- [docs/experiments](https://github.com/rayson-tech/nomarmy/tree/main/docs/experiments): the measured write-ups behind them.
- [policies](https://github.com/rayson-tech/nomarmy/tree/main/policies): how scouts and reviewers are held to account.
- [CONTRIBUTING.md](https://github.com/rayson-tech/nomarmy/blob/main/CONTRIBUTING.md), [SECURITY.md](https://github.com/rayson-tech/nomarmy/blob/main/SECURITY.md), [CODE_OF_CONDUCT.md](https://github.com/rayson-tech/nomarmy/blob/main/CODE_OF_CONDUCT.md).

Configuration variables are `NOMARMY_*`; a legacy `RAYSON_*` variable is translated once at load, with a deprecation warning.

Licensed under [Apache 2.0](https://github.com/rayson-tech/nomarmy/blob/main/LICENSE).
