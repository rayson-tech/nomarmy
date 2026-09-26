<h1 align="center"><img src="https://raw.githubusercontent.com/rayson-tech/nomarmy/main/nomarmy-logo.png" alt="nomArmy" width="320"></h1>

<p align="center">
  <a href="https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml"><img src="https://github.com/rayson-tech/nomarmy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/nomarmy"><img src="https://img.shields.io/npm/v/nomarmy/alpha?label=npm%40alpha" alt="npm"></a>
  <a href="https://github.com/rayson-tech/nomarmy/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

<p align="center"><em>Every byte verified.</em> 🍪</p>

**Your coding assistant plans; sandboxed workers build; nothing counts until nomArmy has checked it.**

AI coding workers are confident. Their "done, all tests pass" is a claim, not evidence. nomArmy lets your coding assistant (Claude Code, Codex or Cursor) hand work to workers called **noms**, then checks every change itself before anything is committed: the real diff, your tests run in a fresh sandbox, a check that those tests actually catch the change, and a secret scan.

## TL;DR

1. **Have** Git, Node 24.16+ (or 26.1+) and [Podman](https://podman.io). On macOS, give Podman 8 GiB: `brew install podman && podman machine init --memory 8192 && podman machine start`.
2. **Install and set up:**
   ```bash
   npm install -g nomarmy@alpha
   cd your-project
   nomarmy setup
   ```
   `nomarmy setup` is a playbook. It shows a checklist and runs the next step each time you say yes:
   ```text
   ✓ Where models run: hosted
   ✓ Installed: OpenClaw 2026.9.6
   → Agents: add a hosted agent
     Roles: add an agent first
     This repo: configure this project
     Check: verify the installation
   Run `nomarmy agents add` now? [Y/n]
   ```
   Stop anytime; `nomarmy setup` picks up where you left off. **Want every step spelled out?** [Example setup: Claude Code, Codex and an API key](https://github.com/rayson-tech/nomarmy/blob/main/docs/setup/example.md) goes command by command.
3. **Use it:** restart Claude Code in the project and ask it to use nomArmy for one small bug that has a test. When that works, try `/feature <what you want built>`.

Stuck? `nomarmy doctor` checks the machine and `nomarmy health` checks everything nomArmy runs on. Upgrading later? `nomarmy update`.

## How every byte gets verified

1. Your coding assistant, the **General**, briefs a job: a task, acceptance criteria, and the tests that prove it.
2. nomArmy creates a git worktree from your branch and runs the nom in a Podman sandbox with no network and no host credentials. (One exception, the Claude subscription: see [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md#security-posture).)
3. The nom edits, runs tests, and ends with a four-line report: `STATUS`, `TESTS`, `NOT_DONE`, `NOTE`.
4. nomArmy treats that report as a claim and checks the evidence itself:
   - reads the real diff from git, not the nom's description of it
   - runs your verification profile in a fresh sandbox
   - reverts the production change and reruns the tests: a test that still passes proves nothing, so the job goes to review instead of being committed
   - blocks on secrets, and flags tests made to pass (new skips, stubbed imports) and code nothing calls
5. Only then does it commit, on the nom's own branch. It never merges into yours: reviewing and integrating stay with the General, and with you.

Failing verification stays failed, unconditionally. A malformed report isn't automatically a failure: if the repository changed, nomArmy verifies independently and may recover the work. And the checks aren't the General's to waive: a repo's `.nomarmy.yml` policy (on by default for new repos) makes verification and the revert check mandatory for every job.

**Checking without building** costs nothing: `mode: verify` runs a verification profile against any branch, with no worker and no model tokens.

## Where the work runs

- **Agents** say where a job can run: an API key, your own ChatGPT or Muse Code subscription, or a local model on llama.cpp.
- **The army** says which role runs on which agent: Sr and Jr devs build, a security analyst and a data architect review, a PM checks the plan, a PO accepts.
- **`/feature`** runs a whole feature end to end, from plan through build, review and acceptance, and hands you a branch to merge.
- **Harnesses** give each repo the right sandbox: Go, Rust, Python and Node (mixed repos too), Playwright browser tests, and fake services like a mock login server, all offline. [Adding one](https://github.com/rayson-tech/nomarmy/blob/main/CONTRIBUTING.md#adding-a-harness) never touches core code.

**What you get is work you don't have to take on faith**, not cheaper work. Delegating costs the General tokens too, for briefing and review: on small, already-diagnosed tickets we measured 4 to 8 times more of the General's tokens than fixing the bug directly, with break-even around 150 lines of context a fix needs to read ([the measurements](https://github.com/rayson-tech/nomarmy/blob/main/docs/experiments/2026-09-20-model-bakeoff-and-economics.md)). It pays off on bigger tickets, parallel work, and anywhere you'd otherwise trust an agent's say-so.

**Have a GPU or a Mac with plenty of memory?** Choose "a local model" in `nomarmy setup`: no per-token bill and your code stays home, but you pay in hardware, power and speed. `nomarmy sizing` tells you what fits. A [shared model server](https://github.com/rayson-tech/nomarmy/blob/main/docs/install.md#a-shared-model-server) works too.

Developed and maintained by Rayson Technologies. This is an alpha (`0.1.0-alpha`).

## Docs

| | |
|---|---|
| [Install](https://github.com/rayson-tech/nomarmy/blob/main/docs/install.md) | Every setup: hosted (API keys and subscriptions), a local model on macOS, Linux, Windows or DGX Spark, a shared model server, Bedrock |
| [Example setup](https://github.com/rayson-tech/nomarmy/blob/main/docs/setup/example.md) | Claude Code, Codex and an API key, command by command |
| [Agents and the army](https://github.com/rayson-tech/nomarmy/blob/main/docs/agents-and-army.md) | Where a job can run, who does what, usage limits, picking an agent |
| [`/feature` runs](https://github.com/rayson-tech/nomarmy/blob/main/docs/feature-runs.md) | A feature end to end, and watching what nomArmy is doing |
| [Your repository](https://github.com/rayson-tech/nomarmy/blob/main/docs/your-repo.md) | `.nomarmy.yml`, verification, dependencies, private registries, what nomArmy checks |
| [Harnesses](https://github.com/rayson-tech/nomarmy/blob/main/docs/harnesses.md) | Ecosystem registry, detection, network levels, and requirements |
| [Configuration](https://github.com/rayson-tech/nomarmy/blob/main/docs/configuration.md) | Settings, swapping the local model, sizing, admission |
| [Reference](https://github.com/rayson-tech/nomarmy/blob/main/docs/reference.md) | Every CLI command and MCP tool |
| [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md) | What the sandbox holds back, and the one exception |
| [Troubleshooting](https://github.com/rayson-tech/nomarmy/blob/main/docs/troubleshooting.md) | Symptoms and fixes |

## Security

A nom gets a writable git worktree inside a Podman sandbox and nothing else: no network, no host credentials, no Podman socket. Every model call is made by OpenClaw on your machine, never from inside the sandbox. Verification can climb a network ladder one rung at a time (fake services on a private network, then an allowlist you approve for a test tenant), but noms never leave `network none`. **The exception is a Claude subscription**, whose tools run on your machine, so nomArmy refuses build jobs on it unless you allow it. Never hand a nom production credentials, deployment access or SSH keys. Details: [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md); to report a vulnerability, [SECURITY.md](https://github.com/rayson-tech/nomarmy/blob/main/SECURITY.md).

## Status

| Capability | Status |
|---|---|
| Verification core: worktrees, nomArmy-owned git, independent verification, the revert check, kept failed worktrees | Working, end-to-end tested |
| `mode: verify`, secret scanning (secretlint, hard block), test-workaround and unwired-code checks | Unit and live tested; the heuristics are review flags |
| Scout and decompose modes, `auto_union` | Unit and live tested |
| Agents: API keys | Live-verified with xAI; other providers built to OpenClaw's documented interface |
| Agents: subscriptions | ChatGPT (Codex) and Muse Code sandboxed and live-verified; Claude live-verified, but its tools run on the host (scout and review by default) |
| Local (llama.cpp) and Bedrock profiles | Working |
| The army and `/feature` | Driven by a real Claude Code General across three runs, about 18 implement jobs |
| Harnesses: Go, Rust, Python, Node and mixed repos; Playwright; fake services | Live-verified offline |
| Private registries and a verification-only network allowlist | Live-verified; each passed an independent security review |

What we've learned from real runs, including where delegating pays and where it doesn't, is in [docs/findings.md](https://github.com/rayson-tech/nomarmy/blob/main/docs/findings.md).

### Known limitations

- **A Claude subscription isn't sandboxed.** Its tools run on your machine, so implement jobs on it are refused unless you set `allow_host_tools: true`. See [Security posture](https://github.com/rayson-tech/nomarmy/blob/main/docs/security.md#security-posture).
- **Your own compose services aren't started yet.** A verification profile that needs a real database from your compose file (`environment: basic` or higher) reports `not_run` rather than running without it (and the compose parser doesn't resolve YAML anchors). Fake services from harnesses, like the mock login server, do run.
- **Private registries don't cover Poetry or Yarn Berry** yet: Poetry can't guarantee a credentialed install runs no package code, and Yarn Berry doesn't read `.npmrc`. uv, pip wheels, npm, pnpm, Yarn Classic and bun work. See [Private registries](https://github.com/rayson-tech/nomarmy/blob/main/docs/your-repo.md#private-registries).
- **A refused model costs one job.** When a vendor refuses a model at run time that OpenClaw lists (gpt-6-sol on a ChatGPT plan), the first job on it fails with `model_not_found`; after that nomArmy won't dispatch it until a job or test call on it works. `army assign` tests the route and catches this before any job.
- **Claude subscription token counts** come from the Claude CLI's own session log, since OpenClaw sees only the final reply; totals include cache reads and writes.
- **Test-workaround detection is a flag, not a verdict**: a legitimate new skip still gets flagged.
- **Deploy-time failures need your own check.** See [Add a check for what unit tests can't see](https://github.com/rayson-tech/nomarmy/blob/main/docs/your-repo.md#nomarmyyml).
- **Same-host sandboxes**: the MCP server, OpenClaw and every job's sandbox run on the machine with the coordinator. Only the model can be elsewhere.

## More

- [docs/findings.md](https://github.com/rayson-tech/nomarmy/blob/main/docs/findings.md): what real runs taught us.
- [docs/experiments](https://github.com/rayson-tech/nomarmy/tree/main/docs/experiments): the measured write-ups behind them.
- [policies](https://github.com/rayson-tech/nomarmy/tree/main/policies): how scouts and reviewers are held to account.
- [CONTRIBUTING.md](https://github.com/rayson-tech/nomarmy/blob/main/CONTRIBUTING.md), [SECURITY.md](https://github.com/rayson-tech/nomarmy/blob/main/SECURITY.md), [CODE_OF_CONDUCT.md](https://github.com/rayson-tech/nomarmy/blob/main/CODE_OF_CONDUCT.md).

Configuration variables are `NOMARMY_*`; a legacy `RAYSON_*` variable is translated once at load, with a deprecation warning.

Licensed under [Apache 2.0](https://github.com/rayson-tech/nomarmy/blob/main/LICENSE).
