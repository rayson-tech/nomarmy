# Experiment: do implement noms displace frontier work? (MacBook Pro M3 Max, 64 GB)

This is the one bet nomArmy was built for and the only one still open. Scouts
were tested on 2026-09-18 and lost to a deterministic tool (see the README's
"Scouts" section). Implement noms have run six times, all correctly rejected,
on a model too small for the job. This run uses a coder-class model on hardware
that can hold it.

The question is not "can the nom write code". It is: **per accepted task, does
the coordinator spend fewer output tokens and turns than doing the ticket
itself, once its review cost is counted?**

## Setup (about ten minutes, most of it the model download)

```bash
git clone git@github.com:rayson-tech/nomarmy.git && cd nomarmy   # or git pull
./install.sh --profile macbook-pro
./scripts/select-model.sh --repo unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF   # pick Q4_K_M
source scripts/lib.sh && load_profile macbook-pro
nomarmy sizing            # expect: Qwen3-Coder-30B-A3B Q4_K_M -> up to 4 noms @ 64K; note the thread hint
nomarmy doctor
./scripts/start-inference.sh macbook-pro
./scripts/configure-openclaw.sh macbook-pro
```

Then in Claude Code, with the `nomarmy-local-worker` MCP server registered:
`local_worker_capacity` should show context per nom read from llama-server's
`/props` and admission `ok`. Keep `NOMARMY_MAX_WORKERS=1` for this experiment;
parallelism is a separate question.

Sanity check before spending an hour: `repo_evidence` with
`op: definitions, query: resolveOutcome` should answer instantly. Then run
ticket 1 alone before queueing the rest.

## The five tickets

All five are bounded, dependency-free (the worktree has no `node_modules` and
the sandbox has no network), and verifiable with a single `node --test` file.
Dispatch each with `local_worker_start`, `mode: implement`,
`verification: quick`, `timeout_seconds: 1800`, then poll with
`local_worker_status` (`wait_seconds: 50`). Paste the brief as `task` and the
bullets as `acceptance`.

### 1. doctor: sandbox image check

**task:** Add a check to `nomarmy doctor` (lib/doctor.mjs) that the Docker
sandbox image `nomarmy-coder:bookworm` exists locally, following the pattern
of the existing pure check functions plus a fact collected in `collectFacts`.

**acceptance:**
- A pure `checkSandboxImage(facts)` returns ok when the image is present and a
  failure with fix `./scripts/setup-sandbox.sh` when it is not.
- `collectFacts` records the fact by running `docker image inspect` only when
  docker is present; absence of docker yields a skipped (ok) result, not a
  crash.
- The check is listed in `evaluateChecks` after `docker-daemon` with id
  `sandbox-image`.
- Tests in tests/doctor.test.mjs cover present, absent and no-docker cases and
  update the whole-report count.
- Verify with `node --test tests/doctor.test.mjs`. Use only Node built-ins. Do
  not run `npm test` or `npm install`.

### 2. sizing: recommend a thread count

**task:** Make `recommend()` in lib/sizing.mjs return a suggested
`NOMARMY_LLAMA_THREADS` in its `env` block, derived from the hardware facts
rather than the logical core count.

**acceptance:**
- Physical cores when known, else logical cores minus two, never below 2 and
  never above the logical count.
- On hardware facts that report performance cores separately (a
  `cpu.performanceCores` field, which may be absent), use that number.
- The value appears in `recommend().env.NOMARMY_LLAMA_THREADS` and in the
  assumptions list with one sentence on how it was chosen.
- Cloud executions do not set it.
- Tests in tests/sizing.test.mjs cover physical-known, logical-only and
  performance-core cases.
- Verify with `node --test tests/sizing.test.mjs`. Node built-ins only.

### 3. hardware: performance-core detection on Apple Silicon

**task:** Extend `detectHardware()` in lib/hardware.mjs so that on darwin it
reads `sysctl hw.perflevel0.logicalcpu` and `hw.perflevel1.logicalcpu` and
reports `cpu.performanceCores` and `cpu.efficiencyCores`, keeping every
existing field unchanged.

**acceptance:**
- A pure parser `parseSysctlPerfLevels(text)` handles both keys present,
  one present, and garbage, returning nulls rather than throwing.
- On non-darwin platforms both fields are `null`.
- Existing tests keep passing; new tests cover the parser and the null case.
- Verify with `node --test tests/hardware.test.mjs`. Node built-ins only.

### 4. transcript: per-call durations

**task:** In lib/transcript.mjs, give each tool call in
`summarizeTranscriptEvents` a `durationMs` computed from the event timestamps
(the assistant message's `timestamp` to the matching tool result's), and add
`toolTimeMs` (sum) and `modelTimeMs` (total elapsed minus tool time) to the
summary.

**acceptance:**
- Missing or unparsable timestamps yield `null` durations and are excluded
  from the sums; nothing throws.
- Timestamps may be ISO strings or epoch milliseconds, both are accepted.
- Existing tests pass unchanged; new tests cover both timestamp forms and the
  missing case.
- Verify with `node --test tests/transcript.test.mjs`. Node built-ins only.

### 5. repo-query: quieter outlines

**task:** In lib/repo-query.mjs, stop `outlineFile` from listing local
variables inside function bodies (for example a `const n` at indent 2 inside a
function) while keeping exported and top-level declarations and class methods.

**acceptance:**
- A `const`/`let`/`var` declaration indented under a function or method is not
  an outline item unless exported.
- Top-level declarations at indent 0, class methods, and everything currently
  asserted in tests/repo-query.test.mjs remain.
- A new test with a nested `const` inside a function asserts it is omitted.
- Verify with `node --test tests/repo-query.test.mjs`. Node built-ins only.

## What to record, per ticket

The job record gives most of it. Add the two numbers only you can supply.

| Field | Where it comes from |
|---|---|
| outcome, coordinatorStatus, recovered | `metadata.json` |
| worker_elapsed, worker_tokens_in/out, tool calls | `metadata.json` `metrics` |
| files changed, tests added | `metadata.json` `testChanges` |
| **review cost**: your output tokens reading the diff and deciding | Claude Code's usage after the review turn |
| **baseline**: your output tokens and turns doing the same ticket yourself | do at least two of the five directly, pick before you see the nom's result |

First-pass accept rate is the headline. If it is under about half, the review
cost eats the saving and the thesis fails on this model class; say so in the
README status table either way.

## What would make this a clean result

- A nom passes the gate with `WORKER_DONE`, tests added, verification `pass`,
  and you accept the diff with at most a one-line change. That is a displaced
  ticket.
- A nom fails the gate on something the gate names (no tests, malformed
  report, verification fail). That is the machinery working and the model not.
- Anything else, especially a `WORKER_DONE` you reject on reading the diff, is
  the case to write up carefully: it is a gate gap, and the most valuable
  finding available.
