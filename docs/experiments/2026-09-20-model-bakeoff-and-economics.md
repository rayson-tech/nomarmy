# Experiment: which local model, and does delegating actually save tokens? (MacBook Pro M3 Max, 64 GB)

The 2026-09-18 experiment asked whether an implement nom displaces frontier
work at all. This one assumes the answer can be yes and asks two sharper
questions: **which local model**, and **at what task size does delegating
actually save the coordinator tokens, versus just being a wash?**

Three models were tested head-to-head on identical, git-verified tasks:
Qwen3-Coder-Next (nomArmy's shipped default, hybrid attention + MoE, ~48-54
tok/s here), gpt-oss-20b (OpenAI's open-weight MoE, ~98 tok/s), and
Qwen3.6-27B (dense, ~9-11 tok/s, chosen for its published 77.2% SWE-bench
Verified score; see sources below).

## Setup

Same as the 2026-09-18 experiment's `install.sh` / `nomarmy sizing` /
`start-inference.sh` steps. Swapping models for comparison is not yet a single
command (see "A real gap this surfaced" below), so each swap was:

```bash
./scripts/stop-inference.sh macbook-pro
NOMARMY_MODEL_REPO=<repo> NOMARMY_MODEL_QUANT=<quant> NOMARMY_MODEL_ALIAS=<alias> \
  NOMARMY_LLAMA_CONTEXT=<n> NOMARMY_LLAMA_PARALLEL=1 ./scripts/start-inference.sh macbook-pro
# then re-onboard OpenClaw's model catalog entry for the new alias (context/
# reasoning metadata needs a manual correction -- openclaw onboard's auto-
# detection guesses wrong for both fields on a custom local endpoint), and
# re-register the MCP server's NOMARMY_WORKER_MODEL env var to match.
```

## Finding 1: task shape decides the economics, not model choice

Six small, real bug-fix/feature tickets (a pagination off-by-one, a null-crash
guard, a date-comparator bug, a currency-formatting feature, a regex
validation bug, a dedup-by-key bug: each a 3-10 line function with its own
failing test) were dispatched to both Coder-Next and gpt-oss-20b. Both went
6/6, independently re-verified by rerunning each specific test file against
the worker's own commit, not just trusting `TESTS: pass`.

Accounting for the coordinator's own token cost (the dispatch brief, the
returned VERIFIED EXECUTION RECORD, and the required independent re-check) put
delegation at roughly **4-8x more tokens than fixing the six directly**, even
with a perfect, zero-review-flag result. The fixed overhead (a verbose,
necessarily verbose trust-verification record, plus the mandatory review that
overhead exists to require) does not shrink because the model got it right.

A seventh case closed the gap: a 144-line LRU cache with a real, subtle bug
(`Map.set()` on an existing key does not move it to the end, so naive
recency-promotion silently breaks: a genuine "gotcha" real engineers get
wrong). The fix was still one line, but reading and understanding 144 lines
of surrounding code was now the real cost. Coordinator-side, that put
delegation at roughly breakeven-to-a-modest-win, not a loss.

**The lever is the ratio of context-needed-to-safely-fix to the diff's own
size, not the diff size itself.** Both the tiny cases and the LRU case had a
~1-line diff; only the amount of surrounding code that had to be read to make
that diff safely changed. Tonight's evidence only covers ~150 lines of
"needed context" landing near breakeven: a genuinely large ticket (300-500
lines, multiple files) is the next test, not yet run.

## Finding 2: all three models solved the hard case correctly; the paths differed a lot

The LRU cache bug, dispatched identically to all three models (`base_ref`
pinned to one commit, task pointed only at the two failing tests, not the
diagnosis):

| Model | Result | Wall-clock | Tool calls | Failures |
|---|---|---|---|---|
| Coder-Next | 16/16, correct | 133s | 5 | 0 |
| gpt-oss-20b (`reasoning: high`) | 16/16, correct | 318s | 21 | 4 |
| Qwen3.6-27B (`reasoning: medium`) | 16/16, correct | 233s | 4 | 0 |
| gpt-oss-20b (`reasoning: medium`) | 16/16, correct | 62s | 9 | 0 |

Every model reasoned to the same correct root cause and wrote essentially the
same one-line fix (Qwen3.6-27B additionally corrected a now-stale comment).
Raw tokens/sec did not predict wall-clock at `reasoning: high`: gpt-oss-20b
(fastest per-token) took the longest and thrashed the most; Qwen3.6-27B
(slowest per-token) beat it by completing in fewer, cleaner turns.

The open question this left (whether gpt-oss's thrash was a reasoning-effort
artifact rather than a model limitation) is answered: dropping gpt-oss-20b to
`reasoning: medium` on the identical ticket cut wall-clock from 318s to 62s,
tool calls from 21 to 9, and failures from 4 to 0, making it the fastest of
all three models tested, on the same hardware, at the same task. **Turn-count
efficiency mattered more than raw generation speed, and reasoning effort was
the dominant lever on turn count**, a bigger effect here than the choice of
model.

## Finding 3: reasoning effort is a real, model-specific dial, not a universal upgrade

Qwen3.6-27B at `reasoning: high` produced a full 630-second timeout with zero
output on an open-ended "find bugs anywhere in lib/*.mjs" task. The identical
task at `reasoning: medium` produced a real, valid, independently-verified
answer. Higher reasoning effort was a strict downgrade on this model for
every task shape tried.

Two llama-server flags nomArmy did not previously expose turned out to be
directly relevant and are now wired up (see README's "Advanced llama-server
tuning"): `--reasoning-budget` (a hard token cap on thinking, independent of
the effort level a request asks for) and `--no-reasoning-preserve` (some chat
templates keep the *entire* thinking trace from every prior turn in context
by default (Qwen3.6-27B's does), which is a concrete, mechanical explanation
for context overflow on long multi-turn tasks that has nothing to do with how
verbose any single answer is).

**The task-shape rule these three findings point at together:** reasoning
effort should scale with how much genuine diagnosis a task needs, and this now
holds across two independent model families, not just one. It added nothing
on the six trivial cases (every model solved those at baseline), was
load-bearing on the LRU case up to a point but actively harmful past it
(gpt-oss-20b at `reasoning: high` thrashed for 318s and 4 tool failures on a
task it solved cleanly at `medium` in 62s), and made an already-mis-scoped
open-ended task fail harder rather than succeed on Qwen3.6-27B. This is the
same line nomArmy's own delegation boundary already draws (bounded execution
to the worker, ambiguous diagnosis stays with the coordinator): a worker
doing more of the coordinator's diagnosis job via more reasoning effort is not
a clean trade even when the model is technically capable of it. Practically:
`reasoning: high` should not be the default for either reasoning-capable
model nomArmy ships against; `medium` is the better starting point, with
`high` reserved for tasks that fail at `medium` first.

## Finding 4: what going local actually buys you, compared to a hosted model

The LRU cache ticket was also run against Claude Haiku 4.5 directly (not
through nomArmy's dispatch tooling, which only targets local profiles;
it ran via a plain subagent pointed at the same worktree, same task, same
failing-tests-only brief, independently verified the same way):

| Model | Result | Duration | Tool calls | Cost |
|---|---|---|---|---|
| Haiku 4.5 | 16/16, correct | 51s | 6 | ~$0.05-0.07 (estimated; exact input/output token split unavailable, only a combined count) |
| gpt-oss-20b (`reasoning: medium`) | 16/16, correct | 62s | 9 | $0 |

Haiku solved it correctly and was the fastest of every model tested tonight,
including every local one. This matters for the honest pitch: **the case for
local was never "beats a frontier-family hosted model on speed or quality,"
it's marginal cost at volume.** A nickel a ticket is nothing once. It is
something at the volume a real fleet of tickets implies, where the local
runs in this experiment cost the same $0 whether it's one job or ten
thousand. Local inference trades a real, nonzero hardware and wall-clock cost
for a marginal-dollar-cost curve that stays flat instead of scaling with
usage: that is the actual claim, not "local models are just as good," which
this same session's earlier findings (six trivial cases, the reasoning-effort
results) already show is task- and configuration-dependent, not automatic.

## Finding 5: `NOMARMY_LLAMA_PARALLEL` above 1 bought nothing on this hardware, and broke a job

`nomarmy sizing` recommends up to 8 concurrent noms on this machine ("more
noms," bounded by memory) against a fixed default of 1 ("nominal," matching
every shipped profile) -- a gap large enough to question. Tested directly:
the same 4 trivial benchmark tickets (case1-4), once dispatched serially
(`max_parallel: 1`) and once concurrently (`max_parallel: 4`), same model
(Qwen3.6-27B), same 4-slot llama-server, same machine, same session.

| | Total wall-clock | Outcome |
|---|---|---|
| Serial (`parallel: 1`) | 532.8s | 3/4 clean, 1 needs-review |
| Concurrent (`parallel: 4`) | 535.9s | 3/4 clean, **1 outright failed (timeout)** |

**Zero net throughput gain.** Individual jobs that completed took 3.4-4.6x
longer each when run concurrently than the same job run alone (case1: 103s
solo vs 467s at 4x; case3: 142s vs 529s; case4: 156s vs 531s) -- worse than
even a naive "split evenly" model would predict. This is a real, measured
answer, not the inference from a memory-fits calculation: this machine's
GPU/unified-memory bandwidth is a shared, saturating bottleneck across
concurrent slots, and `nominal: 1` is not overly conservative here, it is
approximately correct. `nomarmy sizing --noms N` (added this session) now
lets anyone measure their own hardware the same way instead of trusting
either extreme.

One job (case2) didn't just run slow under concurrency, it failed outright:
`stat failed for /workspace/workspace/benchmark/case2-null-truncate/truncate.mjs`
-- the worker's own tool call used a path already containing a redundant
`workspace/` prefix, which the sandbox joined against its own `/workspace`
root and never found. Two things are true about this and both matter for
being honest about what was actually found: the path-joining that failed
lives inside OpenClaw's own sandbox-fs tool, not this codebase, so there is
no fix available here for the underlying join; and at n=1 there is no way to
confirm this was *caused* by concurrency rather than being independent model
flakiness that happened to land in this trial. The one thing confirmed and
fixed here: the worker prompt now explicitly warns against the exact
observed mistake (repeating "workspace" as a path segment), regardless of
which layer ultimately failed on it.

A related, deliberately UNCHANGED finding: the idle-diff circuit breaker
(`makeIdleDiffTick`) never fires until at least one real worktree change has
been observed, by design (`tests/worker-contract.test.mjs`'s
`"never stops before any change has been observed"`) -- a worker still
reading/exploring before its first edit looks identical to one that's
stuck. This means a worker that never makes any progress at all (as case2's
did, if the path failure blocked every subsequent attempt) burns its entire
timeout budget with no early exit, unlike a worker that edits once and then
stalls. That is a real, known cost of the current design, not something
changed tonight -- it is the same class of decision as `reviewRequired` on
a `not_run` verification earlier this session: a tested, intentional
tradeoff, not a bug to silently patch.

## A real gap this surfaced (since closed)

Comparing models used to mean a fully manual restart-and-re-register dance
for every swap (stop/start inference, fix OpenClaw's auto-detected context
and reasoning metadata, update the MCP registration's `NOMARMY_WORKER_MODEL`
env var by hand, restart the coordinator session). Several real bugs were
found and fixed via exactly this dance: `connectClaude`'s re-add silently
dropped previously-set env vars on every reinstall, separately had the `-e`
flag argument order backwards, and (the deepest one) `config/common.env`
already had a `NOMARMY_WORKER_MODEL` key, but nothing ever read it back out;
picking a non-default model in `nomarmy setup`/`model` silently had zero
effect on which model workers actually dispatched to, for every model choice
ever made through the documented path, not just this session's. Compounding
it: `install.sh` called a separate, older bash implementation
(`scripts/setup-claude-worker.sh`) that never got any of these fixes at all,
so the documented "correct" install path was broken the whole time regardless
of what `lib/connect.mjs` did.

Fixed: `config/common.env` is now the single source of truth `nomarmy
connect` reads to keep the registration in sync, `nomarmy setup`/`model`
write it consistently, `install.sh` calls the one (now-correct) JS
implementation instead of the old bash script, and the bash script is
deleted rather than left as an untested second copy of the same logic.
`nomarmy model` also now offers to resync the registration in the same
command, and its curated model menu was expanded from the one default entry
to the three real, measured options from this document's own findings.

## Sources for Qwen3.6-27B's cited benchmark score

- [Qwen3.6-27B beats much larger predecessor on most coding benchmarks](https://the-decoder.com/qwen3-6-27b-beats-much-larger-predecessor-on-most-coding-benchmarks/): 77.2% SWE-bench Verified, 53.5% SWE-bench Pro.
- [Qwen3.6-27B-FP8 reaches 90.0% on SWE-bench Verified with an engineered agent stack](https://github.com/QwenLM/Qwen3/discussions/1846): a separately-reported, higher number using extra scaffolding (retries, multi-sampling) not representative of nomArmy's one-shot-plus-verification dispatch; the 77.2% base number is the fairer comparison point.
