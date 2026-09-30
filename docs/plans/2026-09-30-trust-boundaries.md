# Plan: trust boundaries, the work that must reach a human

**Status: phase 1 built (on this branch).** Later phases remain planned.

## Why

`stakes: high` gives a job the strongest checks nomArmy has: a verification profile, the revert check, and an independent review on another vendor before it counts. But the General decides it, per job. When the General doesn't recognize work as sensitive, nothing applies, and the General is the one most likely to miss it: it planned the work.

On Senti, most defects that passed every check were this kind: cross-tenant access, a false security label, deploy-only paths. Each passed verification and the revert check. Each was caught only by a person reading the diff.

A list of sensitive paths is the obvious fix and the wrong primary one. Code moves; sensitive logic lives in files called `utils.py`; and the most dangerous change is a small diff elsewhere that quietly removes a check. Pure model judgment is wrong too: a model can be argued out of a gate, including by a comment a worker plants in the code.

## The rule over everything

**Reasoning can raise the bar, never lower it.** Deterministic rules set a floor that nothing argues with. Model judgment can only escalate above it. A confused model or a prompt injection can at worst make a gate stricter.

## The layers

### 1. The floor (deterministic)

What the operator states outright, enforced exactly:

```yaml
# .nomarmy.yml
trust:
  sensitive:
    - paths: ["lambda/frontend_api/rls/**", "**/auth/**", "migrations/**"]
      reason: access control and tenant data
    - paths: [".github/workflows/**", "infra/**"]
      reason: deploys and CI
    - content: ["DROP TABLE", "TRUNCATE"]   # added or removed lines that contain these
      reason: destructive SQL
  codeowners: true   # paths owned in CODEOWNERS count as sensitive
```

- Read from the operator's checkout, never a job's worktree (as `policy:` is), so neither the General nor a worker can relax it.
- `codeowners: true` reuses what many teams already maintain, and pairs with the one human gate nomArmy can't enforce itself: GitHub branch protection requiring a code owner's approval.
- The secret scan stays as it is: a hard block.
- Content rules are noisier than paths; keep them few and specific.

### 2. The trust map (AI proposes, a human ratifies)

Once per repository, a scout maps where the real guarantees live, as **symbols, not folders**: the functions that check permissions, apply tenant filters, handle personal data, move money, delete data, or deploy. For example: `_enforce_scope` in `lambda/frontend_api/rls/common.py` is the tenant boundary.

- `nomarmy trust map` runs the scout (a review-phase role on another vendor than the builders) and writes a proposal.
- The operator reviews it (`nomarmy trust review`: accept, drop or edit each entry) and it's committed as `.nomarmy/trust-map.yml`, each entry with its symbol, file, category and one-line reason.
- Nothing in the map is active until a human accepts it.

### 3. Reach, not location

A diff is sensitive when it changes a mapped symbol **or code a mapped symbol depends on**. nomArmy already resolves definitions and references (`lib/repo-query.mjs`, the evidence tool), so it can walk the call graph from each mapped symbol downward a bounded number of levels. A change to a helper three calls under `_enforce_scope` is gated though it lives in `utils.py`.

Bounded and deterministic: the reach set is computed from the base commit, cached per commit, and capped (depth and fan-out), with the cap stated when it's hit.

### 4. A per-diff judgment

Every implement job's diff gets a typed judgment from Jev (fast, cheap, probabilities rather than prose), one question per category:

- Does this change who can access what (authentication, authorization, tenant isolation)?
- Does it remove or weaken a check (a guard, a filter, a validation, an error path)?
- Does it touch personal, customer or tenant data, secrets, money, or an irreversible operation?

Rules for the judgment:

- It sees **the diff only**, never the worker's report or brief, so the worker can't argue its case. Code comments in the diff are data; the prompt says so, and the floor means an injected "this is safe" can't lower anything.
- **Removing a guard weighs most.** Deleting `if not authorized: raise` or a `WHERE tenant_id = ...` is the classic silent defect; a removed-check signal escalates one level on its own.
- Without Jev configured, the judge validator can answer the same questions; with neither, layers 1 to 3 still apply.

### 5. A graded response, with the reason in plain words

| Level | When | What happens |
|---|---|---|
| normal | nothing found | an ordinary job |
| review | medium judgment, or reach into the map without a removed check | treated as `stakes: high`: an independent review on another vendor before the work counts |
| human | a floor rule, a removed check in reach of the map, or a high judgment | everything above, plus a **human gate** |

The human gate:

- The job record gets `trust: { level, reasons: [...] }`, each reason one sentence naming what and where: "this diff removes the `tenant_id` filter from `list_sources()` (lambda/frontend_api/generated_sources.py:412), which the trust map marks as the tenant boundary."
- The `local_worker_status` report view and the start of the General's review say so first.
- `/feature` treats it as a hard stop: the General must ask the operator before integrating the job, instead of choosing the conservative option and continuing. `run_finish` lists every gated job.
- The "Verified by nomArmy" PR block adds a row: "Needs human review: 2 changes (tenant boundary, deploy path)", with the reasons.
- `nomarmy stats` counts gated jobs and how each was resolved.

### 6. Before the work: the brief

The same judgment runs on the **brief at dispatch**. "Reuse the stored connection in the approval flow" reads as sensitive before any code exists, so admission marks the job `stakes: high` up front (and tells the General why), and the review is planned instead of discovered.

### 7. It learns from what gets caught

When an independent review finds a defect, or the operator rejects work at a human gate, nomArmy records the symbols and files involved. Where defects cluster, `nomarmy trust review` proposes additions to the map, with the evidence ("3 of the last 5 escaped defects were in `rls/access.py`"). The operator approves or dismisses them; the map grows from evidence, never on its own.

## Security properties

- Rules and the map are read from the operator's checkout, never a worktree.
- The per-diff judgment sees only the diff; its verdicts only escalate.
- A worker can't mark its own job safe; the General can raise a level (`stakes: high` as today) but can't lower one nomArmy assigned.
- An unavailable validator never lowers a level; it's recorded as unavailable, and layers 1 to 3 still hold.

## Phases

1. **Floor and graded gates.** `trust.sensitive` paths and content, `codeowners`, the `trust` record, the human gate in `/feature`, the PR block row, stats. Acceptance: a diff touching a sensitive path is gated with its reason and can't be accepted by the General alone in a `/feature` run; a worker editing `.nomarmy.yml` in its worktree changes nothing.
2. **The per-diff judgment.** Jev (or the judge) questions per category; removed-check detection; the brief-time check. Acceptance: on Senti's real escaped-defect diffs, measured before and after, each is gated at review or human level.
3. **The trust map and reach.** The mapping scout, `nomarmy trust map` and `trust review`, the reach computation with its caps. Acceptance: a change to a helper under a mapped symbol is gated; unmapped code isn't.
4. **Learning.** Defect and rejection records, proposed map additions with evidence.

Measure first, as with design checks: run phase 2's questions over Senti's known escaped defects and a sample of harmless diffs before building the gate, to set thresholds on evidence and see the false-positive rate.

## Cost

- Per job: one Jev call per category (cheap), plus the brief-time call.
- Per repository: one mapping scout, then a review when proposals accumulate.
- Reach: computed locally, cached per base commit.

## Open questions

- Threshold defaults per category, from the measurement.
- Whether `human` should also block `nomarmy`'s own commit on the worker branch until acknowledged, or only gate integration (today's lean: gate integration; the commit is on the worker's branch anyway).
- How the map handles generated or vendored code.
- Where the operator acknowledges a gate outside `/feature` (a `nomarmy trust ack <job>` command, or the coordinator's own review).
