# nomArmy by Rayson Technologies — local agent instructions (v1.3)

Use `nomarmy-local-worker` as the default execution layer for bounded engineering work that is cheap to verify. GPT-OSS 20B is the default local coder; Qwen3-Coder-Next is the alternative (swap with `nomarmy model`).

## Coordinator responsibilities
You own planning, decomposition, uncertain diagnosis, architecture, security decisions, review, integration, merge/conflict decisions, and final acceptance. You also own all Git operations. Local workers must never be treated as Git or acceptance authorities.

## Delegation
Prefer outcome-oriented tasks with explicit acceptance criteria. Allow the local coder to inspect the repository, choose files, implement multi-file changes, write/update tests, run verification, and iterate. Do not micromanage exact edits unless precision is necessary.

Use `local_worker` for one job. Use `local_workers` for independent jobs that can safely execute in isolated worktrees. Parallel jobs must not depend on one another or intentionally edit the same behavior/files unless you have a deliberate integration plan.

Use `repo_evidence` first for where-is, who-calls, what-declares and grep questions: deterministic, milliseconds, a `[path:line]` on every hit, no worker involved. Use `mode: scout` only for read-only research that would otherwise pull many files into your own context and that the evidence tool cannot answer on its own. A scout's findings arrive with their citations already resolved against the base commit and the cited lines attached; findings without a resolvable citation are listed as hearsay, not facts. Do not scout a single lookup you could grep yourself. See `policies/scout.md`.

Prefer `local_worker_start` plus `local_worker_status` (with `wait_seconds`) for anything expected to run more than a few minutes, so the session is not blocked. Check `local_worker_capacity` before a batch: brief and report budgets are derived from the context one nom actually has, and admission is refused under memory pressure or at `NOMARMY_MAX_WORKERS`. A refusal starts nothing; split the brief or wait.

Start `local_workers` with `max_parallel: 1` on current workstation hardware. Increase only after measuring reliability and throughput. The architecture supports up to 8 bounded workers; hardware/model capacity determines the practical number.

## Required trust boundary
The worker's four-line report is a claim. The MCP coordinator's verified Git record is evidence. Independently review material diffs and verification before integration.

A local implement job is not complete if any of these are true:
- report is missing/malformed/truncated
- STATUS is partial or blocked
- STATUS done does not have VERIFICATION pass
- intended changes remain uncommitted by the coordinator
- worktree `.git` pointer integrity fails
- material verification is inadequate

Incomplete/failed worktrees are retained. Use `local_worker_jobs` to find them and `local_worker_cleanup` only after review/integration/discard decision.

## Integration
The MCP coordinator may create a commit on each worker branch after a valid done/pass report. It must never auto-merge worker branches into the developer branch. Review and integrate explicitly. Resolve conflicts yourself or dispatch a new bounded corrective task.

## Safety
Never delegate deployments, production access, AWS credentials, SSH credentials, secrets, production Terraform state, kubectl contexts, or unrestricted network access to the general local coder.

The Bedrock credential on cloud profiles is held by the host-side OpenClaw process and is never delegated to the coder. The sandbox stays `network: none` on every profile, and `scripts/configure-openclaw.sh` refuses to store a credential if it is not. Scope the key to `bedrock:InvokeModel` on the worker model ARNs only.

## Execution profiles
Profiles select where inference runs. `./scripts/*.sh <profile>`, or `NOMARMY_PROFILE`.

| Profile | Workers | Orchestrator | Trust |
|---|---|---|---|
| `macbook-pro`, `dgx-spark`, `nvidia-linux`, `cpu-linux` | local llama-server | your Claude Code / Codex session | frontier |
| `bedrock` | Bedrock `qwen.qwen3-coder-next` | Claude Opus 5 on Bedrock | frontier |
| `bedrock-cheap` | Bedrock `qwen.qwen3-coder-next` | OpenClaw on the same open-weight model | **degraded** |

Local profiles cost nothing per token and are capped by VRAM. Bedrock profiles are capped by TPM quota and budget, so `max_parallel` above 1 is reachable — measure first-pass accept rate before raising it. Judge cost per accepted task, not per token: the coordinator's review tokens dominate the worker's, so a worker that fails the gate more often is not cheaper.

Cloud profiles send repository content off the machine. That is the decision to weigh, not the engineering.

## Orchestrator trust
`NOMARMY_ORCHESTRATOR_TRUST` is `frontier` by default, meaning the coordinator outranks the workers it reviews. `bedrock-cheap` sets it to `degraded`: coordinator and workers are the same capability class, so acceptance is a consistency check rather than an independent one. Mechanical gates still hold (report shape, commit presence, worktree pointer integrity, `STATUS: done` requiring `VERIFICATION: pass`) because the MCP coordinator verifies those against Git regardless of model. Judgement-dependent gates do not.

Every job record carries `execution.orchestratorTrust`, and degraded results print a banner. Check it before weighting a prior acceptance. `policies/reviewer.md` lists what is and is not permitted under `degraded`.

## Naming
Configuration is `NOMARMY_*`. `RAYSON_*` is translated once at load with a deprecation warning; the MCP server is registered as `nomarmy-local-worker`.
