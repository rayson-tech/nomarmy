# What we've learned running nomArmy

Findings from real runs, kept here so the README can stay a guide. Each links to the experiment write-up it came from where there is one.

## The economics depend on task size, not model choice

nomArmy's bet is to spend scarce frontier intelligence on intent and judgment, and abundant worker intelligence on implementation and repair. Measured so far ([model bake-off and economics](experiments/2026-09-20-model-bakeoff-and-economics.md)), whether that pays depends on the task:

- Small, precisely diagnosed fixes lose to the coordinator doing them itself.
- Delegation pays when the context a fix needs is meaningfully larger than the fix.
- A same-ticket comparison against a hosted model put local at $0 and 62 s against about $0.05 to $0.07 and 51 s: real at scale, not proven as a universal curve.

Local also means the model behind the seat improves with your hardware, with nothing else in the harness changing.

## Writing the evidence is the diagnosis

Writing a job's `evidence` thoroughly enough to hand a worker every fact it needs *is* the diagnosis. If what's left after that is a small, mechanical change, you've already paid the cost delegation exists to save. A ticket that's part diagnosed fix and part bulk, mechanically verified work (writing a batch of tests, say) usually splits better than it delegates whole: keep the fix, hand off only the part that's nom-shaped.

## Briefing errors look like model limits

Two findings from one adversarial night of runs, recounted after separating a harness bug (since fixed) from what the models did:

- Briefing a worker against code with no reachable test path (a function that can't be imported without cloud credentials) produces exactly the failure it looks like it should: the worker burns its whole budget hunting for a harness that doesn't exist. That's a briefing error, not a cheap-tier limit. The same work went smoothly once moved to a layer a test could reach.
- 3 of 5 completions that night shipped a test that passed whether or not the feature existed. It's briefable: one paragraph naming that failure mode took an identical job, same base, same brief otherwise, from 1 of 3 inert tests to 3 of 3 real, for about 5 extra seconds.

The night first scored 2 clean jobs of 7. After excluding 2 jobs an idle-diff harness bug had killed, it was 5 clean of 5, with per-job corrections trending to zero as the brief improved, not the model.

## Reading a diff isn't verifying it

A local 20B worker was asked to add a `doctor` command with tests. It produced 156 lines that read as competent (JSDoc throughout, clean structure) with six defects invisible without running it, including a file that didn't parse and no test file despite an explicit acceptance criterion. nomArmy committed nothing; the record showed `tests added: 0`, taken from the repository, not the worker's claim. Reading the diff would plausibly have approved it. Running it didn't.

## Frontier workers, in three real /feature runs

About 18 implement jobs across three runs on a real product repo, with a Claude Code General and Codex, Claude, Grok and Muse workers:

- Every job nomArmy committed as done was real.
- It caught what workers got wrong: two tests that passed only in the full suite (run alone, they failed), a false "Implemented" after an idle stall, and verification failures it refused to commit.
- Two malformed Claude reports were committed only because independent verification passed on its own.
- What it can't catch is repo-specific: a module left out of a Lambda bundle passed every unit test. That's a verification profile for the repo to add (see the README's known limitations).

## More workers isn't automatically faster

On one Apple Silicon machine, going from 1 to 4 parallel local workers produced no net throughput gain. Raising local worker count is an empirical question: measure accepted tickets per hour before assuming more is faster.
