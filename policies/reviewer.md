# Reviewer Policy — v1.2

Reviewer capability remains coordinator/frontier-model controlled by default. A future local read-only reviewer may be added, but a worker must never review/approve its own work as final authority.

## Why the capability gap matters

Acceptance in nomArmy is not a procedure, it is an asymmetry. The worker's four-line report is a claim; the coordinator is trusted to judge it because the coordinator is the stronger model. Remove the gap and the gate still runs, but it stops meaning anything: a model of the same class is grading output it could have produced itself, including the mistakes it is blind to.

`NOMARMY_ORCHESTRATOR_TRUST` records which regime is in force.

## `frontier` (default)

Coordinator outranks the workers it reviews. Everything in this file and in `policies/orchestrator.md` holds as written. Profiles: all local profiles, and `bedrock`.

## `degraded` (opt-in)

Coordinator and workers are the same capability class. Profile: `bedrock-cheap`.

Under this setting the acceptance gate is a consistency check, not an independent one. It will still catch a malformed report, a missing commit, a failed worktree pointer, and a `STATUS: done` without `VERIFICATION: pass` — those are mechanical and the MCP coordinator verifies them against Git regardless of model. It will *not* reliably catch a plausible-looking diff that is wrong, a test that passes for the wrong reason, or a named regression test that does not actually pin the behaviour it claims to.

Every job record produced under this setting carries `execution.orchestratorTrust: "degraded"` and a banner on its formatted result. Do not remove either.

Permitted under `degraded`:
- bounded, reversible work where a wrong accept is cheap and caught downstream
- throughput experiments measuring first-pass accept rate against a `frontier` baseline

Not permitted under `degraded`:
- security decisions, credential handling, or dependency changes
- architecture, schema, or public interface changes
- anything heading for a release, a customer, or a production system
- final acceptance of work that no human or frontier coordinator will review afterwards

## Measuring before trusting

Before treating `degraded` as viable for a class of work, measure first-pass accept rate on that class against `bedrock`. `local_worker_jobs` exposes the inputs: `coordinatorStatus`, `reportValidation`, and `execution` per job. A cheaper worker that needs more rounds is not cheaper — the coordinator's review tokens dominate the worker's.
