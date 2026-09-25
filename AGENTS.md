# nomArmy by Rayson Technologies: local worker instructions

Use `nomarmy-local-worker` for bounded engineering work that is cheap to verify. GPT-OSS 20B is the default local coder; Qwen3-Coder-Next is the alternative (swap with `nomarmy model`).

## Coordinator responsibilities

Codex owns planning, decomposition, uncertain diagnosis, architecture, security decisions, review, integration, merge/conflict decisions, final acceptance, and all Git operations. Local workers are not Git or acceptance authorities.

## Delegation

Give workers outcome-oriented tasks with explicit acceptance criteria. They may inspect the repository, select files, implement multi-file changes, write or update tests, and run verification. Do not prescribe exact edits unless precision requires it.

Use `local_worker` for one job and `local_workers` only for independent jobs that can safely run in isolated worktrees. For local-model jobs, start with `max_parallel: 1` and increase only after measuring reliability and throughput. Api and subscription jobs don't need it: each agent's `max_concurrent` in agents.yml sets how many run at once.

## Trust boundary and integration

A worker's four-line report is a claim; verified repository state is evidence. Before integration, confirm the report is complete, has `STATUS: done` and `VERIFICATION: pass`, inspect material diffs, and run adequate verification. Retain incomplete or failed worktrees for review. Never auto-merge a worker branch into the developer branch.

## Safety

Do not delegate deployments, production access, AWS credentials, SSH credentials, secrets, production Terraform state, Kubernetes contexts, or unrestricted network access to the local coder.

## Execution profiles

Profiles select where inference runs: the local profiles (`macbook-pro`, `dgx-spark`, `nvidia-linux`, `cpu-linux`) serve workers from this machine's llama-server, `bedrock` serves them from Amazon Bedrock with a Claude Opus 5 coordinator, and `bedrock-cheap` serves both from the same open-weight model.

Local profiles cost nothing per token and are capped by VRAM. Bedrock profiles are capped by quota and budget, so parallelism above 1 is reachable; measure first-pass accept rate before raising it. Cost per accepted task is the number that matters; coordinator review tokens dominate worker tokens.

Cloud profiles send repository content off the machine.

## Orchestrator trust

`NOMARMY_ORCHESTRATOR_TRUST` is `frontier` by default. Under `bedrock-cheap` it is `degraded`: coordinator and worker are the same capability class, so acceptance stops being an independent check. Mechanical gates still hold; judgement-dependent ones do not. Every job record carries `execution.orchestratorTrust` and degraded results print a banner. See `policies/reviewer.md`.

## Naming

Configuration is `NOMARMY_*`; `RAYSON_*` is translated once at load with a deprecation warning. The MCP server is `nomarmy-local-worker`.
