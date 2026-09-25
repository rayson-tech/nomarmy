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

## The one real design question: shared state

Much of `server.mjs` reads module-level state: `projectDir`, `stateRoot`, the job tracker, the budgets cache, `contextInfo`, the verification runner. Moving functions out as-is would mean either importing that state from a shared module (a hidden global, just relocated) or threading it through every call.

The plan: one small `lib/server-context.mjs` that creates and holds that state (`createServerContext({ projectDir, stateRoot })`), passed explicitly to the modules that need it. Tests already build their own state in several places, so this also makes them simpler.

## Order of work

Each step is its own pull request, so each can be reviewed and reverted on its own, and the tests must pass at every step.

1. The leaf modules with no shared state: `report.mjs`, `worker-prompt.mjs`, `job-format.mjs`, `diff-checks.mjs`, `process.mjs`.
2. `server-context.mjs`, then `git-record.mjs`, `outcome.mjs` and `union.mjs`.
3. `job-budgets.mjs`, `selection.mjs`, `openclaw-run.mjs`.
4. `execute.mjs` and `admission.mjs`, the ones that touch the most state.
5. `server.mjs` left with the tool definitions. Point tests at the new modules and delete the re-exports kept during the move.

While moving each piece, read its comments against its code and fix any that no longer match.

## Not in scope

Changing any behavior, renaming the MCP tools, or changing the job record format. Those are separate changes, easier to review once the code is split.
