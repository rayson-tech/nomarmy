# Deeper checks: validators

nomArmy's built-in checks run on every job: it reads the real diff, runs your verification profile itself, reverts the change to prove a test catches it, blocks rewritten checks and secrets, and flags weakened tests (see [What else nomArmy checks](your-repo.md#what-else-nomarmy-checks)). Validators go further, and each is optional:

| | Checks | Turn it on | Costs | Sends code off your machine |
|---|---|---|---|---|
| [Mutation testing](#mutation-testing) | Do the tests pin down what the changed lines do? | `mutation:` in `.nomarmy.yml` | One verification run per mutant | No |
| [Jev](#jev) | Do a scout's cited lines support its finding? Does a worker's report match its diff? | `nomarmy validators add jev` | A fraction of a cent a job | Yes, to TypeSafe |
| [Model judge](#model-judge) | Does the diff meet each acceptance criterion, match the report, keep its tests as strong? | `nomarmy validators add judge --agent <name> --model <model>` | One call to your agent a job | Yes, to that agent's vendor |

`nomarmy validators list` shows which are on.

## What every validator shares

- **Flags only.** A validator can raise a review flag. It can never pass a check, clear a flag or let a commit through: what Jev and a judge read (diffs, reports) was written by the worker being judged, and a model can be talked into a verdict. A flag shows up in the job's issues, where the General reads it before accepting.
- **An outage never holds a job up.** A validator that's down or slow is skipped for a while, the job notes the skip, and its result doesn't depend on it.
- **Restart open coordinator sessions** after turning one on or off.

## Mutation testing

The revert check proves a test notices the change *disappearing*. Mutation testing proves the tests pin down *what the changed lines do*: a boundary, a condition, a constant.

```yaml
# .nomarmy.yml
mutation:
  mutants: 5         # 1 to 20
  max_seconds: 300   # stop after this, whatever's left
```

After verification passes on a diff that changed code, nomArmy plants small mistakes in the lines the worker changed, one at a time (`<` to `<=`, `&&` to `||`, `true` to `false`, `18` to `19`), and reruns the job's verification profile on each. Every one should fail. One that still passes means no test checks what that line does, and the job is flagged with the exact line and change:

```
MUTANTS SURVIVED: 2 of 4 small mistakes planted in the changed lines still passed profile 'quick',
so no test pins down what those lines do: age.js:2 `>=` → `>` in `return age >= 18;`; age.js:2 `18` → `19` ...
```

That's a live run: a worker's `isAdult(age)` passed verification with tests for 30 and 10, never 18.

- It edits only code, never strings or comments, in JavaScript, TypeScript, Python, Go, Rust, Java, C-family and similar files. No mutation tool needs installing in the sandbox.
- The worker's file is restored and checked after every mutant; a failed restore blocks the commit.
- Some mutants can't change behavior at all, so a survivor raises review rather than blocking.
- It's per repository because it costs a verification run per mutant: keep `mutants` small where your suite is slow.

## Jev

[Jev](https://docs.typesafe.ai) is TypeSafe's fast judgment model. It makes two judgments nomArmy's mechanical checks can't:

- **Do a scout's cited lines support its finding?** nomArmy checks that a citation exists; Jev reads the whole cited range against the claim. A finding that fails is marked `[JEV: ...]` in the scout's report.
- **Does a worker's report match its diff?** A contradiction ("restored check.js to base commit" beside a diff that rewrote it) raises review.

```bash
nomarmy validators add jev     # asks for your TypeSafe key without showing it; one test call
nomarmy validators test jev    # check the key still works
nomarmy validators remove jev  # off, and the saved key deleted
```

The key is saved to `~/.config/nomarmy/secrets/typesafe.key`, readable only by you, never in a config file or a registration. To keep it in an environment variable instead, set `key_env: <NAME>` under `jev:` in `~/.config/nomarmy/validators.yml`. For scripts, `nomarmy validators add jev --key-stdin` reads the key from stdin.

**What we measured** on real job records: every mismatched citation we planted was caught, and the real findings it flagged were real problems (a finding that misread its own cited line; true claims citing the wrong lines). It flagged none of 30 real reports against their own diffs and caught a worker's false claim. A job's checks cost a fraction of a cent.

**It sends excerpts of your code** (findings, cited lines, diffs, worker reports) to TypeSafe. A failed or slow call (15 seconds at most) skips Jev for every job for 10 minutes, and a job never spends more than 45 seconds on it.

## Model judge

Jev is fast at narrow questions. For judgments that take a few steps, make one of your agents a judge:

```bash
nomarmy validators add judge --agent grok --model grok-4.7
nomarmy validators add judge --agent claude --model claude-haiku-4-5 --host-tools
nomarmy validators test judge
nomarmy validators remove judge
```

After each implement job it answers three questions about the diff, in one call: does it meet each acceptance criterion, does it match the worker's report, and did any changed test get weaker? An "unmet", "contradicts" or "weakened" answer raises review.

- **Pick a different vendor** than the workers it judges, so its review is independent. Move to a newer model by running `add judge` again.
- **Host tools need consent.** The judge runs through OpenClaw in an empty folder, told not to use tools, but OpenClaw can't turn an agent's tools off, and a Claude subscription's tools run on your machine. So a judge on that agent needs `--host-tools`, the same consent `allow_host_tools` asks for a build job. An api key, Codex or Muse agent needs none.
- It sends the diff and report to that agent's vendor, like any job on it. The local model can't be a judge (too little context for a diff).

**What we measured** with Claude Haiku 4.5 as judge on 12 real jobs: it flagged none against their own diffs, caught 8 of 12 reports paired with another job's diff and a worker's false claim, and never called a real job's acceptance criterion unmet (it said "unclear" when it couldn't tell). About 13 seconds a job.

## Which to use

- **Mutation testing** in repositories where the tests really matter; it's free apart from time, and nothing leaves your machine.
- **Jev** for fast, cheap checks on every job, if sending excerpts to TypeSafe is acceptable.
- **A judge** for acceptance criteria and test weakening, on a sandboxed agent from a different vendor than your workers.
