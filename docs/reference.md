# Command reference

## The `nomarmy` CLI

Every command proposes before it writes: a `[y/N]` prompt, or an explicit flag under `--json`. All take `--json` and `--repo <dir>`.

| Command | What it does |
|---|---|
| `nomarmy doctor` | Checks this machine is ready, with a fix for anything missing. Start here. |
| `nomarmy setup` | The setup playbook: a checklist of where models run, install, agents, roles, this repo and a check, running the next step when you say yes. `--status` prints it only; `--choose`, `--hosted` and `--llama-url` set where models run. |
| `nomarmy sandbox` | The Podman VM every sandbox shares (macOS; on Windows Podman runs inside WSL, sized by `.wslconfig`): memory, disk and images. `--memory <GiB>` resizes it (refused while jobs run, below 4 GiB, or above three quarters of the machine); `--prune` removes images no container uses; `--repair` restores rootless Podman's subordinate ID ranges if they're missing (refused while jobs run). |
| `nomarmy install` | Runs the bundled `install.sh` for the profile setup chose (`--profile` to override, `--no-claude` to skip the Claude Code registration). |
| `nomarmy connect [claude] [codex] [cursor] [--scope user\|local\|project]` | Registers nomArmy with each coordinator and installs `/feature`, the status line and the notifier. No target: pick interactively. `--scope local` registers it for this repository only, just for you; `--scope project` writes a committed `.mcp.json` or `.cursor/mcp.json` for the team (see [Per-repository registration](install.md#per-repository-registration)). Codex has only the user scope. |
| `nomarmy stats [--since 7d\|<date>] [--until <date>] [--role <role>] [--model <model>] [--repo <path\|name>] [--all-repos] [--details] [--all-suggestions] [--json]` | One screen by default: how many "done, tests pass" claims held up and how many nomArmy caught, new tests shown to fail without their change, committed high-stakes jobs still needing a review, the top routing tips, and spend. `--details` adds everything the records show: jobs by mode, role and model; code committed; worker and job time; tokens and API spend; how often a "done, tests pass" report failed independent verification or passed with tests that couldn't catch the change; what didn't complete; reviewers; review flags. From verified records, never reports. `--repo senti` matches a repository by folder name. The General gets the same through the `stats` tool. |
| `nomarmy validators <list\|add jev\|test jev\|remove jev>` | Optional semantic checks with your own key: Jev judges whether a scout's cited lines support its finding and whether a worker's report matches its diff. Only adds review flags; sends code excerpts to TypeSafe. See [Validators](validators.md#jev). |
| `nomarmy validators <add judge --agent <name> --model <model> [--host-tools]\|test judge\|remove judge>` | Makes one of your agents a model judge for implement jobs: acceptance criteria, report vs. diff, weakened tests. Only adds review flags. An agent whose tools run on your machine needs `--host-tools`. See [Validators](validators.md#model-judge). |
| `nomarmy jobs --stop <job> [--reason <text>]` | Stops a running job's worker, keeping its worktree for `continue_from`. |
| `nomarmy mcp` | Starts nomArmy's MCP server on stdio with this machine's settings: what a `--scope project` registration runs. |
| `nomarmy init` | Proposes a `.nomarmy.yml` from what the repo contains. |
| `nomarmy agents list\|add\|update\|remove` | Where jobs can run. See [Agents](agents-and-army.md#agents-where-a-job-can-run). |
| `nomarmy army show\|init\|assign\|general` | The General and the roster. See [The army](agents-and-army.md#the-army-who-does-what). |
| `nomarmy jobs [--watch\|--events\|--prune\|--wait <jobId>]` | What's running across every session, and what just finished. `--wait <jobId> [--timeout <seconds>]` waits for one cross-session job (default 1800 seconds; add `--json` for structured output). |
| `nomarmy health` | Runs the health checks now. |
| `nomarmy statusline` | nomArmy's part of Claude Code's status line. |
| `nomarmy config paths` | Where each config file lives. |
| `nomarmy config max-jobs [n]` | How many api and subscription jobs run at once, across every session (default 4); with `n`, sets it. Warns when the Podman VM is too small. |
| `nomarmy model` | Changes the local model. |
| `nomarmy sizing` | Recommends context, slots and workers. `--check` evaluates the loaded profile; `--noms N` sizes for a count. |
| `nomarmy start` / `stop` | Starts or stops local inference. |
| `nomarmy scan` | Reports the repo's execution environment. `--check` diffs it against `.nomarmy.yml`. |
| `nomarmy validate` | Validates `.nomarmy.yml`. |
| `nomarmy update` | Updates nomArmy and reconnects every coordinator it finds. From npm: installs the latest alpha. From a clone: pulls (fast-forward only). Then it names each open session still running an older nomArmy (app, terminal, start time) so you know which to restart; until you do, `army` and `local_worker_capacity` say so, and `nomarmy health` flags a coordinator still running an older copy. |
| `nomarmy uninstall` | Removes the MCP registration and install. `--clear-agents`, `--clear-models` or `--all` go further. |

## MCP tools

What the General uses. Every job takes the same shape: a `task`, optional `acceptance`, a `mode` and a timeout.

| Tool | What it does |
|---|---|
| `local_worker` | Runs one job and waits for it. |
| `local_worker_start` / `local_worker_status` | Starts a job in the background / waits for its result. The start response includes `nomarmy jobs --wait <jobId>` for background monitoring. `report: true` returns just the report (a scout's cited findings), the outcome, issues and commit; `full: true` the whole record. Timeouts default to 10 minutes, 20 for a review scout (`reviews` set, or a review-phase role). |
| `local_workers` | Runs a batch of independent jobs in parallel. `auto_union: true` merges them into one integration branch for review. |
| `repo_evidence` | Deterministic answers (definitions, references, outlines, grep, files) with `[path:line]` on every hit, no model. |
| `army` | The General's charter and agent, then this repo's roles and who runs each. |
| `run_start` / `run_status` / `run_finish` | A `/feature` run: its limits, usage per agent, warnings, paused agents and log. |
| `local_worker_capacity` | Context, budgets, memory pressure and what's running. |
| `local_worker_stop` | Stops a running job's worker (no report recovery, no verification) and keeps its worktree for `continue_from`. Works for any session's job. |
| `stats` | What the job records show for this repo (or `all_repos`, or another `repo` by name), filtered by `since`, `until`, `role` and `model`; `format: json` for the raw numbers. |
| `local_worker_jobs` | Recent job records; `full: true` for the complete manifest. |
| `local_worker_config` | This repo's verification profiles. |
| `local_worker_cleanup` | Removes one worktree and branch. Recognizes a cherry-picked branch as integrated by content. |
| `local_worker_sweep` | Removes worktrees that are provably empty. `dry_run` previews. |

A job's `mode` is `implement` (edits, then nomArmy verifies and commits), `scout` (read-only research, every claim cited as `[path:start-end]` and checked against the base commit) or `decompose` (read-only, proposes independent subtasks for the General to dispatch).
