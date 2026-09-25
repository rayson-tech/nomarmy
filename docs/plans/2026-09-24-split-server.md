# Plan: split `mcp/server.mjs` into modules

`mcp/server.mjs` is about 4,200 lines: the MCP tool definitions plus nearly every piece of job execution. It works and is well covered (930 tests), but it's hard to review, hard for a new contributor to find their way around, and easy for a comment in one place to contradict code in another (a reviewer found one). This plan breaks it up without changing behavior.

## Goal

- `mcp/server.mjs` holds only the MCP wiring: tool schemas, handlers and startup, well under 1,000 lines.
- Each piece of job execution lives in its own `lib/` module that can be read and tested on its own.
- No behavior change. Every existing test keeps passing, importing from the new modules.

## Proposed modules

Line numbers are from `mcp/server.mjs` at the time of writing.

| New module | Moves out of `server.mjs` | Roughly |
|---|---|---|
| `lib/process.mjs` | `run`, `git`, `gitRaw`, `resolveExecutable`, `mapLimit`, the tick helpers (`makeIdleDiffTick`, `makeAbandonedBackgroundProcessTick`, `makeHeartbeatTick`, `combineTicks`) | 90-310 |
| `lib/worker-prompt.mjs` | `workerPrompt`, `reportRecoveryPrompt`, `describeRecoveryChanges`, `renderAcceptance` | 325-395 |
| `lib/job-budgets.mjs` | `currentBudgets`, `refreshBudgets`, `budgetsForJob`, `budgetsForPool`, `budgetsForSubscriptionWorker`, `recordedBudgets`, the catalog refresh | 455-730 |
| `lib/selection.mjs` | `expandJobs`, `resolvePoolSelection`, `resolveSubscriptionSelection`, `withPoolEntrySlot`, `assertNoProviderConflict` | 530-820 |
| `lib/openclaw-run.mjs` | `runOpenClaw`, `resolveWorkerSandboxOverride`, `salvageFinishedRun`, the error parsers, sandbox container reaping and sweeping | 820-1240 |
| `lib/git-record.mjs` | porcelain parsing, `collectGitRecord`, `isRuntimeJunk`, `createCoordinatorCommit`, `coordinatorCommitMessage`, worktree pointer checks | 1240-1290, 1680-1860, 2320-2380 |
| `lib/diff-checks.mjs` | test classification, scoped test-selection risk, unwired definitions, mislabeled test names, the secret scan, the revert check (`planProductionRevert`, `runRegressionCheck`) | 1280-1830 |
| `lib/report.mjs` | `parseWorkerReport` and its helpers | 1855-1960 |
| `lib/outcome.mjs` | `resolveOutcome`, `OUTCOMES`, the policy helpers (`repoPolicy`, `policyAdmissionProblems`, `applyVerificationPolicy`), `buildMetrics`, `usageMetrics` | 1990-2320 |
| `lib/union.mjs` | `selectUnionCandidates`, `buildUnionBranch` | 2130-2240 |
| `lib/execute.mjs` | `executeJob`, `executeImplement`, `executeScout`, `executeDecompose`, status writing | 2385-3090 |
| `lib/admission.mjs` | `admit`, lanes and slots (`jobLane`, `runningCount`, `withAgentSlot`, `splitJobsByLane`), `refusalText`, the capacity snapshot | 3340-3560 |
| `lib/job-format.mjs` | the banners, compact records, `formatResult`, `formatUnion` | 3087-3260 |

## Progress: done

| Step | Module | PR |
|---|---|---|
| 1 | `lib/report.mjs`, `lib/worker-prompt.mjs` | #4 |
| 2 | `lib/outcomes.mjs`, `lib/job-format.mjs` | #5 |
| 3 | `lib/diff-checks.mjs` | #6 |
| 4 | `lib/server-context.mjs`, `lib/process.mjs` | #8 |
| 5 | `lib/git-record.mjs` | #9 |
| 6 | `lib/outcome.mjs` | #10 |
| 7 | `lib/agent-config.mjs`, `lib/selection.mjs` | #11 |
| 8 | `lib/budget-state.mjs`, `lib/job-budgets.mjs` | #12 |
| 9 | `lib/openclaw-run.mjs` | #13 |
| 10 | `lib/verification-flow.mjs` | #14 |
| 11 | `lib/execute.mjs` | #15 |
| 12 | `lib/admission.mjs` | #17 |

`mcp/server.mjs`: 4,235 lines before, 813 after (the tool definitions, wiring and startup). All 931 tests unchanged and passing throughout.

Every step was a nomArmy job declared `refactor: true` (Jr Dev on Codex gpt-5.6-sol for verbatim moves, Sr Dev on gpt-6-astra for factories): 14 jobs in 2.3 hours on one ChatGPT subscription, 11 committed first time. nomArmy committed each only because verification passed with no test file touched; each new module was then checked line by line against the original, CI passed on each PR, and the installed server was smoke-tested. One job (step 10) reported partial against an acceptance criterion that was too strict and was accepted on review; the first attempts at step 1 were held back by the two nomArmy gaps below.

What the first steps taught:

- **The revert check can't judge a refactor.** Reverting a pure move restores working code, so the tests pass either way. That's why declared refactors exist (#3): verification must pass and no test file may change.
- **nomArmy's own suite has to pass inside its sandbox.** A unit test ran a real `podman build`, which worked on the host and failed in the sandbox (#2).
- **Leaf means no shared state, not just no imports.** `OUTCOMES` had to move before the formatting code could (a cycle otherwise). `run()`, `git()` and `gitRaw()` default their working directory to the server's `projectDir`, so `lib/process.mjs` belongs with the shared-state steps below, not step 1. The revert-check functions (`gitShowBuffer` through `runRegressionCheck`) call the verification runner, so they move with verification.

## The one real design question: shared state

Much of `server.mjs` reads module-level state: `projectDir`, `stateRoot`, the job tracker, the budgets cache, `contextInfo`, the verification runner. Moving functions out as-is would mean either importing that state from a shared module (a hidden global, just relocated) or threading it through every call.

The plan: one small `lib/server-context.mjs` that creates that state (`createServerContext({ env })`), passed explicitly to the modules that need it. **Not a module-level singleton:** several tests import a fresh copy of `server.mjs` (`server.mjs?union-test=...`) with different environment settings, and a singleton in `lib/` would not reload with them. So a module that needs state exports a factory (`createGitRecord(ctx)`, `createAdmission(ctx)`, ...) and `server.mjs` wires them to its one context.

The state that moves into the context: `projectDir`, `stateRoot` and the roots under it (`jobsRoot`, `runsRoot`, `leasesRoot`, `slotsRoot`), `execution`, the budget cache (`budgets`, `contextInfo`, `hardwareSnapshot`), `activeRunId`, `verificationRunner`, and the running-job tracker. Mutable values sit behind getters and setters on the context, so every module sees the current value.

## Order of work

Each step is its own pull request, so each can be reviewed and reverted on its own, and the tests must pass at every step.

1. The leaf modules with no shared state: `report.mjs`, `worker-prompt.mjs`, `outcomes.mjs`, `job-format.mjs`, `diff-checks.mjs`. **Done.**
2. `server-context.mjs` and `process.mjs` together (the context supplies `run()`'s default working directory), then `git-record.mjs`, `outcome.mjs` and `union.mjs`.
3. `job-budgets.mjs`, `selection.mjs`, `openclaw-run.mjs`.
4. `execute.mjs` and `admission.mjs`, the ones that touch the most state.
5. `server.mjs` left with the tool definitions. Point tests at the new modules and delete the re-exports kept during the move.

While moving each piece, read its comments against its code and fix any that no longer match.

## Not in scope

Changing any behavior, renaming the MCP tools, or changing the job record format. Those are separate changes, easier to review once the code is split.
