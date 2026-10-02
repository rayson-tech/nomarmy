# Trust map and bounded reach

Only `.nomarmy/trust-map.yml` in the operator checkout is authoritative. The
executor snapshots it before worker execution. Editing that file in a worker
worktree is itself a human-level change, including deletion or replacement.

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

Save that response, then run `nomarmy trust map --from scout.yml`. This validates
the schema and definition citations before writing
`.nomarmy/trust-map.proposed.yml`. Proposals never affect job gating.

`nomarmy trust review` presents each proposal for accept, drop, or edit. Accepted
entries merge into the existing map, without the proposal-only `line` field.
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
reach, and dynamic calls or import aliases may not be resolved. Depth defaults
to 3 and fan-out to 25. The computation API accepts smaller or larger explicit
bounds (depth 0 to 10, fan-out 1 to 100).

The job state directory contains a `trust-reach` cache keyed by base commit,
accepted map, algorithm version, and bounds. Records state the base commit,
cache key, bounds, heuristic nature, and any caps. Unresolved mapped symbols and
capped scans conservatively require review for a nonempty diff.

Changing a mapped symbol or a reachable helper requires review. Reasons identify
the changed symbol, file and line, boundary category, and dependency path. A
removed-check finding within that reach raises the level to human. Other trust
floors and previous job escalations cannot be lowered by this analysis.
