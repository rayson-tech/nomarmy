# Experiment: which local model, and does delegating actually save tokens? (MacBook Pro M3 Max, 64 GB)

The 2026-09-18 experiment asked whether an implement nom displaces frontier
work at all. This one assumes the answer can be yes and asks two sharper
questions: **which local model**, and **at what task size does delegating
actually save the coordinator tokens, versus just being a wash?**

Three models were tested head-to-head on identical, git-verified tasks:
Qwen3-Coder-Next (nomArmy's shipped default, hybrid attention + MoE, ~48-54
tok/s here), gpt-oss-20b (OpenAI's open-weight MoE, ~98 tok/s), and
Qwen3.6-27B (dense, ~9-11 tok/s, chosen for its published 77.2% SWE-bench
Verified score — see sources below).

## Setup

Same as the 2026-09-18 experiment's `install.sh` / `nomarmy sizing` /
`start-inference.sh` steps. Swapping models for comparison is not yet a single
command — see "A real gap this surfaced" below — so each swap was:

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
validation bug, a dedup-by-key bug — each a 3-10 line function with its own
failing test) were dispatched to both Coder-Next and gpt-oss-20b. Both went
6/6, independently re-verified by rerunning each specific test file against
the worker's own commit, not just trusting `TESTS: pass`.

Accounting for the coordinator's own token cost (the dispatch brief, the
returned VERIFIED EXECUTION RECORD, and the required independent re-check) put
delegation at roughly **4-8x more tokens than fixing the six directly**, even
with a perfect, zero-review-flag result. The fixed overhead — a verbose,
necessarily verbose trust-verification record, plus the mandatory review that
overhead exists to require — does not shrink because the model got it right.

A seventh case closed the gap: a 144-line LRU cache with a real, subtle bug
(`Map.set()` on an existing key does not move it to the end, so naive
recency-promotion silently breaks — a genuine "gotcha" real engineers get
wrong). The fix was still one line, but reading and understanding 144 lines
of surrounding code was now the real cost. Coordinator-side, that put
delegation at roughly breakeven-to-a-modest-win, not a loss.

**The lever is the ratio of context-needed-to-safely-fix to the diff's own
size, not the diff size itself.** Both the tiny cases and the LRU case had a
~1-line diff; only the amount of surrounding code that had to be read to make
that diff safely changed. Tonight's evidence only covers ~150 lines of
"needed context" landing near breakeven — a genuinely large ticket (300-500
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

The open question this left — whether gpt-oss's thrash was a reasoning-effort
artifact rather than a model limitation — is answered: dropping gpt-oss-20b to
`reasoning: medium` on the identical ticket cut wall-clock from 318s to 62s,
tool calls from 21 to 9, and failures from 4 to 0, making it the fastest of
all three models tested, on the same hardware, at the same task. **Turn-count
efficiency mattered more than raw generation speed, and reasoning effort was
the dominant lever on turn count** — a bigger effect here than the choice of
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
by default — Qwen3.6-27B's does — which is a concrete, mechanical explanation
for context overflow on long multi-turn tasks that has nothing to do with how
verbose any single answer is).

**The task-shape rule these three findings point at together:** reasoning
effort should scale with how much genuine diagnosis a task needs, and this now
holds across two independent model families, not just one. It added nothing
on the six trivial cases (every model solved those at baseline), was
load-bearing on the LRU case up to a point but actively harmful past it —
gpt-oss-20b at `reasoning: high` thrashed for 318s and 4 tool failures on a
task it solved cleanly at `medium` in 62s — and made an already-mis-scoped
open-ended task fail harder rather than succeed on Qwen3.6-27B. This is the
same line nomArmy's own delegation boundary already draws (bounded execution
to the worker, ambiguous diagnosis stays with the coordinator) — a worker
doing more of the coordinator's diagnosis job via more reasoning effort is not
a clean trade even when the model is technically capable of it. Practically:
`reasoning: high` should not be the default for either reasoning-capable
model nomArmy ships against; `medium` is the better starting point, with
`high` reserved for tasks that fail at `medium` first.

## A real gap this surfaced

Comparing models currently means a manual restart-and-re-register dance for
every swap (stop/start inference, fix OpenClaw's auto-detected context and
reasoning metadata, update the MCP registration's `NOMARMY_WORKER_MODEL` env
var, restart the coordinator session). Two real bugs were found and fixed via
exactly this dance: `connectClaude`'s re-add silently dropped previously-set
env vars on every reinstall, and separately had the `-e` flag argument order
backwards, both now fixed in `lib/connect.mjs`. `nomarmy model` doesn't yet
manage the MCP env vars at all, only the llama-server model — that's the next
concrete tooling gap, not a research question.

## Sources for Qwen3.6-27B's cited benchmark score

- [Qwen3.6-27B beats much larger predecessor on most coding benchmarks](https://the-decoder.com/qwen3-6-27b-beats-much-larger-predecessor-on-most-coding-benchmarks/) — 77.2% SWE-bench Verified, 53.5% SWE-bench Pro.
- [Qwen3.6-27B-FP8 reaches 90.0% on SWE-bench Verified with an engineered agent stack](https://github.com/QwenLM/Qwen3/discussions/1846) — a separately-reported, higher number using extra scaffolding (retries, multi-sampling) not representative of nomArmy's one-shot-plus-verification dispatch; the 77.2% base number is the fairer comparison point.
