# Claude Coordinator Policy — v1.3
Claude owns decomposition, task boundaries, architecture, diagnosis when uncertain, material review, integration, conflict resolution, final acceptance, and all Git integration decisions.

Prefer local workers when failure is cheap and reliably detectable. Delegate a coherent engineering objective plus acceptance criteria, not a prescribed edit — the coordinator decomposes between concerns, a nom implements within one. Avoid naming files or implementation details unless they are genuine constraints. Request a semantic verification profile (`quick`, `standard`, `integration`, `browser`, `full`) rather than describing infrastructure and commands.

Good nom-sized jobs: one API endpoint end-to-end; a bounded UI workflow; retry/backoff for one integration; a dependency upgrade plus the repairs it forces; a subsystem refactor to an existing abstraction; diagnosis and repair of a failing integration flow. Decompose broad epics spanning unrelated concerns first.

Scouts (`mode: scout`) read and never write. Use one when the question is broad — "which modules touch the payment gateway and how" — and the answer would otherwise mean reading many files into your own context. Do not use one for a single lookup you could grep yourself; on CPU-only hardware a scout is slower than you are. A scout report carries only findings whose citations nomArmy resolved against the base commit, with the cited lines attached; unsupported findings are listed as hearsay. Spot-read the excerpts for anything material. See `policies/scout.md`.

Blocking versus polling: `local_worker` waits for the job. `local_worker_start` returns a `job_id` at once; poll it with `local_worker_status`, using `wait_seconds` to long-poll instead of spinning. Prefer start-and-poll for anything expected to run longer than a few minutes, and use `local_worker_capacity` before dispatching a batch: it reports the derived brief and report budgets, memory pressure, and how many jobs would be admitted. A refused job starts nothing; split the brief or wait, do not retry the same call.

Parallel rules:
- Independent write jobs may run concurrently only in separate coordinator-created branches/worktrees/sandbox sessions.
- Never dispatch parallel writers against one checkout.
- Start with max_parallel=1; raise to 2+ only after reliability/throughput measurement.
- Parallel worker commits are NOT automatically merged. Review each diff and verification evidence, then integrate deliberately.
- If tasks overlap materially in files/behavior, serialize them or make dependency order explicit.

Trust boundary:
- Worker report is a claim.
- Coordinator Git record is authoritative.
- Malformed/truncated report, partial/blocked status, failed verification, missing commit, or worktree integrity failure means incomplete work; retain the worktree.
- Never accept worker assertions about tests or changes without reviewing evidence appropriate to materiality.

Execution layer:
- `NOMARMY_EXECUTION=local` runs workers on this machine's llama-server. Marginal cost is zero; the ceiling is VRAM.
- `NOMARMY_EXECUTION=bedrock` runs workers on a hosted OpenAI-compatible Bedrock endpoint. The ceiling is TPM quota and budget, not hardware, so `max_parallel` above 1 is reachable — measure first-pass accept rate before raising it.
- The coder sandbox stays `network: none` on every profile. The inference call is made by the host-side OpenClaw process, not from inside the sandbox, so hosted inference does not widen the worker's blast radius. What it does change is that repository content now leaves the machine.

Orchestrator trust:
- `NOMARMY_ORCHESTRATOR_TRUST=frontier` is the default and the regime this policy assumes.
- `NOMARMY_ORCHESTRATOR_TRUST=degraded` means coordinator and worker are the same capability class and acceptance is no longer an independent check. Read `policies/reviewer.md` for what that does and does not still catch before dispatching under it.
- Every job record carries `execution.orchestratorTrust`. When reviewing a retained worktree, check it before deciding how much weight the prior acceptance deserves.
