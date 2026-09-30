# Plan: acceptance contracts, what a feature promises, kept in the repo

**Status: design, after beta.** On a branch until beta ships. The first contract, `acceptance/windows-first-class.yml`, is backfilled and checked by a prototype; nothing else is built.

## Why

Acceptance criteria live in each job's brief and in its record under `~/.local/share/nomarmy-local-agents`, on one machine. They're never versioned, never reviewed in a pull request, and gone for anyone else. Once a feature merges, nobody can ask "does this still do what we agreed it would?" The tests that prove it are in the repo, but nothing says which test proves which promise, so a failing test reads as "3 tests failed", not "the Windows connect promise broke".

## The contract

One file per feature, committed with it, reviewed in the same pull request:

```yaml
# acceptance/<feature>.yml
feature: Windows as a first-class front end, with the engine in WSL2
run: run-windows-first-class-wsl2-engine-a9ffdd
pr: 118
criteria:
  - id: WIN-6
    text: nomarmy connect on Windows registers Claude Code, Codex and Cursor to start nomArmy inside WSL, with no shell
    proven_by:
      - file: tests/wsl-connect.test.mjs
        test: "connectViaWsl registers ${target} and installs only Windows playbooks"
    status: met          # met | unproven | broken | retired
    security: false      # marks a criterion for trust boundaries
    note: optional context
```

- **Criteria are durable behavior, not job hygiene.** The backfill showed job acceptance items mix the two: "connect registers claude into WSL with no shell" is a promise; "npm test passes", "no em dashes" and "ci.yml is identical to the base commit" are instructions for one job. Only promises go in the contract.
- **`proven_by` names tests by file and full name**, quoted: test names contain colons (`setup: ${name} gives the exact fix`), which broke the first draft's `file: name` shorthand. A test defined in a loop (a template-literal name) is matched on its fixed prefix.
- **`unproven` is a first-class status.** A criterion no test pins (docs matching behavior, say) is listed, not hidden, and shows in the PR block.
- **IDs are stable** (`WIN-6`); text can be reworded without breaking references.

## How it's used

1. **At the start of a `/feature` run** the General writes the contract from the plan: each outcome becomes a criterion with an ID. Job briefs carry the IDs they serve, so a job's acceptance items are split into the criteria it proves and its own hygiene.
2. **At the end** nomArmy fills in `proven_by` from the tests each job added or changed. Those tests passed the revert check, so they're proven to fail without their change. The General reviews the mapping, and the file goes into the PR. The "Verified by nomArmy" block adds a row: "Acceptance: 13 criteria met, 1 unproven (WIN-12)".
3. **`nomarmy acceptance check`** runs each criterion's tests (and only those) and reports per criterion: met, broken (with the failing test), or unproven. It's model-free, fast, and runs in CI. The prototype on the Windows contract: 14 criteria, 39 test references, 13 met, 1 unproven, in seconds.
4. **Later work is checked against it.** When a job touches code a contract's tests cover, its brief carries those criteria, and the judge checks the diff doesn't break them. A job that breaks one comes back needing review with the criterion named.
5. **Drift is caught, not silent.** Renaming or deleting a referenced test makes `acceptance check` report the reference as missing: the contract has to be updated in the same change, on purpose. Retiring a criterion is an explicit `status: retired` with a reason.

## How it connects

- **Design checks** (independent tests from the spec, in the beta plan's after-beta list) need exactly this written spec: the second agent writes tests from the contract's criteria, never seeing the code.
- **Trust boundaries** (docs/plans/2026-09-30-trust-boundaries.md): `security: true` criteria are part of the map, and breaking one is a human gate.
- **Stats**: criteria met, broken and unproven per repository, over time.

## Why files in the repo, not GitHub Issues

Versioned with the code they describe, reviewed in the same PR, readable by workers inside the sandbox (which has no network), and they work offline and outside GitHub. The PR description can still render them as a checklist.

## Phases

1. **`nomarmy acceptance check`** and the schema, with the Windows contract as the fixture: per-criterion met/broken/unproven, missing references reported, a CI step. Acceptance: renaming a referenced test fails the check with the criterion and the old name.
2. **`/feature` writes and fills contracts**: IDs from the plan, briefs carry criterion IDs, `proven_by` from each job's new tests, the PR block row.
3. **Later jobs are checked against contracts**: criteria for touched code in the brief; the judge's check; breaking one needs review.
4. **Backfill** for other merged features where job records exist, curated like the Windows one.

## Open questions

- Referencing tests by name versus tagging the test itself with the ID (`test("[WIN-6] connectViaWsl ...")`): tags survive renames but touch every test; names need no test changes. The prototype uses names.
- Whether criteria belong per feature file or in one `acceptance/` index per repository.
- How to handle a criterion proven only by an end-to-end or manual step (a real Windows install): a `proven_by` of kind `manual` with a date and who checked it, instead of `unproven`.
