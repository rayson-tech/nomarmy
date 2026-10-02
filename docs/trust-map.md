# Trust map and bounded reach

Only `.nomarmy/trust-map.yml` in the operator checkout is authoritative. The
executor snapshots it before worker execution. Editing that file in a worker
worktree is itself a human-level change, including deletion or replacement.
The same gate protects `.nomarmy/trust-map.proposed.yml` and its provenance
receipt, `.nomarmy/trust-map.provenance.json`.

## Mapping and ratification

The CLI does not have a job-dispatch client. `nomarmy trust map` writes
`.nomarmy/trust-map.scout.md`, a read-only scout brief for the General to dispatch
through `local_worker_start`. It selects the repository's `security-analyst`
review role, or the first configured review-phase role. The General should use a
vendor independent of the builders. The brief lists eligible files, excluding
usual generated/vendor directories and files marked `linguist-generated` or
`linguist-vendored` in `.gitattributes`.

The scout returns a YAML array:

```yaml
- symbol: _enforce_scope
  file: lambda/rls/common.py
  category: tenant
  reason: Enforces the caller's tenant scope before accessing records
  line: 12
```

Save that response, then run
`nomarmy trust map --from scout.yml --scout-job <scout-job-id>`. This validates
the schema and definition citations before writing
`.nomarmy/trust-map.proposed.yml`. Proposed entries are not active boundaries,
but any worker edit to the proposal file is human-gated. The command records
its writer name, scout job id and a digest of the exact proposal bytes in the
operator-side receipt. The job id is supplied by the General, not inferred
from scout text; it is attribution, not proof of the scout's identity.

`nomarmy trust review` presents each proposal and its scout job origin for
accept, drop, or edit. JSON listings include a parallel `origins` array.
`--accept-all` requires an unchanged proposal with a receipt written by
`nomarmy trust map` and a recorded scout job id. Missing or invalid receipts,
missing job ids, manual proposals, and edited proposal bytes require explicit
per-entry decisions. Unknown origins are displayed as `unknown-or-edited`.
Accepted entries merge into the existing map, without the proposal-only `line` field.
Dropping a proposal does not delete an already accepted map entry. Categories
are `access`, `tenant`, `data`, `money`, `delete`, `deploy`, and `secrets`.

For scripting:

```sh
nomarmy trust review --json
nomarmy trust review --accept-all --json
nomarmy trust review --decisions '[{"action":"accept"},{"action":"drop"}]' --json
```

`--json` alone only lists pending entries. Decisions must cover every entry in
order. An edit is `{"action":"edit","entry":{...}}`, where `entry` has exactly
`symbol`, `file`, `category`, and `reason`. The whole batch is validated before
writing. Review clears the proposal once accepted entries have been saved.

## Reach

Before worker edits or continuation changes are applied, the executor uses the
untouched base worktree to compute downward symbol dependencies with
`lib/repo-query.mjs` outlines and references. This is heuristic symbol-name
resolution, not a compiler call graph: ambiguous definitions can overapproximate
reach. ES named aliases and namespace members, CommonJS destructuring aliases,
and Python from-import aliases and module aliases resolve to repository-local
definitions. Unresolved used import bindings record a cap rather than implying
that their targets are safe. Both K&R and Allman function bodies are included.
Depth defaults to 3 and fan-out to 25. The computation API accepts smaller or larger explicit
bounds (depth 0 to 10, fan-out 1 to 100).

The job state directory contains a `trust-reach` cache keyed by base commit,
accepted map, algorithm version, and bounds. Records state the base commit,
cache key, bounds, heuristic nature, and any caps. Unresolved mapped symbols and
capped scans conservatively require review for a nonempty diff.

Changing a mapped symbol or a reachable helper requires review. Reasons identify
the changed symbol, file and line, boundary category, and dependency path. A
removed-check finding within that reach raises the level to human. Other trust
floors and previous job escalations cannot be lowered by this analysis.

## Limits

Reach is static and heuristic. Dynamic dispatch such as `user.handler(user)`
cannot be resolved statically and is left to the diff judgment, not certified by
an empty reach result. Runtime module loading, re-exports, computed property
names, binding shadowing and language-specific module resolution can also need
judgment. Import-looking comments and strings do not create import bindings.
Prompt, policy or query files (`.md`, `.txt` and similar) count as production
only when production code names them in a string literal. A file the code loads
by a computed path (`"sys" + ".md"`, a template, a directory read) stays
outside the judgment and the detector, so list such files under
`trust.sensitive.paths` in `.nomarmy.yml`: the floor gates any change to them.
Files a test runner loads by convention (`conftest.py`, a configured setup
file) are treated as tests unless production code imports them.

Test-named files outside test directories are production when their language has
no import extraction. Go's `_test.go` files are the exception because the Go
toolchain never links them into production builds. Test directories retain their
existing rule (`tests/`, `test/`, `__tests__/`, and `spec/` with test evidence).
The JS/TS import scan follows only relative `./` and `../` specifiers. A
production file loading a test-named file through a path alias (`@/x`, tsconfig
paths, or package.json `"imports"`), a bare specifier, or a computed import is not
seen by this scan. List such files in `trust.sensitive.paths` in `.nomarmy.yml`
so changes remain human-gated even when the scan excludes them from judgment.

The proposal receipt detects edits; it is not a cryptographic attestation of a
scout job. Its authority depends on the operator checkout and the human gates
on both the proposal and receipt, just as the active map does.

## Human sign-off and learning

Outside or inside `/feature`, the operator records a human gate decision with:

```sh
nomarmy trust ack <job-id> --accept --reason "Reviewed the tenant boundary"
nomarmy trust ack <job-id> --reject --reason "Missing tenant filter"
```

Only a job from this repository with `trust.level: human` can be acknowledged.
`trust.ack` is an append-only array of decisions with `decision`, `who`, `when`
and `reason`. Identity is the repository's Git `user.email`, falling back to the
OS user. The last decision is current; earlier decisions remain in the record.
Sign-off never changes the level, outcome, tests or review requirements. A reject
is an acknowledged refusal, not permission to integrate. The status report and
jobs listing carry the history; `run_finish` labels gates pending or acknowledged
and includes the latest decision. Only pending gates count in the PR block's
"Needs human review" row.

Finished independent review scouts with `reviews: <job-id>` contribute supported
findings with explicit defect language and citations to that job's changed files.
Failed, same-provider, weak and unsupported findings do not contribute. Defect
classification and symbol extraction from cited excerpts are heuristic. Every
human rejection contributes its changed files and the recorded floor/reach reasons.
The executor records review evidence immediately; `trust review` also collects
persisted review records idempotently, including older reviews.

Evidence is append-only, repository-scoped by canonical checkout path, in
`$NOMARMY_AGENT_STATE/trust-learning/<repo-hash>/evidence.jsonl` (the normal nomArmy
state directory if unset), never in the repository. Two or more distinct evidence
records touching a symbol or file produce an inert suggestion. Each suggestion
shows the event count, total recorded defects/rejections, and job ids. A review
contributes once even if several findings cite the same symbol. The initial
category is `access` as a review placeholder; edit it to the appropriate category.
If no symbol has enough evidence, a file-level suggestion uses `symbol: "*"`.
An accepted whole-file entry gates changes anywhere in that file, including code
without a recognized definition; removed checks raise it to human.

Learning suggestions appear after scout proposals in `trust review`, with the
same accept/drop/edit decisions. `--accept-all` cannot approve learning suggestions.
Nothing becomes active until explicitly accepted or edited. Dropping a suggestion
persists the evidence fingerprint outside the repository, so rereading or collecting
the same evidence cannot propose it again. New evidence for that target makes it
eligible again. Already mapped targets are not suggested again.
