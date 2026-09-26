# Command reference

## The `nomarmy` CLI

Every command proposes before it writes: a `[y/N]` prompt, or an explicit flag under `--json`. All take `--json` and `--repo <dir>`.

| Command | What it does |
|---|---|
| `nomarmy doctor` | Checks this machine is ready, with a fix for anything missing. Start here. |
| `nomarmy setup` | The setup playbook: a checklist of where models run, install, agents, roles, this repo and a check, running the next step when you say yes. `--status` prints it only; `--choose`, `--hosted` and `--llama-url` set where models run. |
| `nomarmy sandbox` | The Podman VM every sandbox shares (macOS, Windows): memory, disk and images. `--memory <GiB>` resizes it (refused while jobs run, below 4 GiB, or above three quarters of the machine); `--prune` removes images no container uses; `--repair` restores rootless Podman's subordinate ID ranges if they're missing (refused while jobs run). |
| `nomarmy install` | Runs the bundled `install.sh` for the profile setup chose (`--profile` to override, `--no-claude` to skip the Claude Code registration). |
| `nomarmy connect [claude] [codex] [cursor]` | Registers nomArmy with each coordinator and installs `/feature`, the status line and the notifier. No target: pick interactively. |
| `nomarmy init` | Proposes a `.nomarmy.yml` from what the repo contains. |
| `nomarmy agents list\|add\|update\|remove` | Where jobs can run. See [Agents](agents-and-army.md#agents-where-a-job-can-run). |
| `nomarmy army show\|init\|assign\|general` | The General and the roster. See [The army](agents-and-army.md#the-army-who-does-what). |
| `nomarmy jobs [--watch\|--events\|--prune\|--wait <jobId>]` | What's running across every session, and what just finished. `--wait <jobId> [--timeout <seconds>]` waits for one cross-session job (default 1800 seconds; add `--json` for structured output). |
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

## MCP tools

What the General uses. Every job takes the same shape: a `task`, optional `acceptance`, a `mode` and a timeout.

| Tool | What it does |
|---|---|
| `local_worker` | Runs one job and waits for it. |
| `local_worker_start` / `local_worker_status` | Starts a job in the background / waits for its result. The start response includes `nomarmy jobs --wait <jobId>` for background monitoring. |
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
