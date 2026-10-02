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
The proposal receipt detects edits; it is not a cryptographic attestation of a
scout job. Its authority depends on the operator checkout and the human gates
on both the proposal and receipt, just as the active map does.
