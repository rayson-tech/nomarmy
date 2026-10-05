# Deeper checks: validators

nomArmy's built-in checks run on every job: it reads the real diff, runs your verification profile itself, reverts the change to prove a test catches it, blocks rewritten checks and secrets, and flags weakened tests (see [What else nomArmy checks](your-repo.md#what-else-nomarmy-checks)). Validators go further, and each is optional:

| | Checks | Turn it on | Costs | Sends code off your machine |
|---|---|---|---|---|
| [Mutation testing](#mutation-testing) | Do the tests pin down what the changed lines do? | `mutation:` in `.nomarmy.yml` | One verification run per mutant | No |
| [Jev](#jev) | Do a scout's cited lines support its finding? Does a worker's report match its diff? | `nomarmy validators add jev` | A fraction of a cent a job | TypeSafe by default; no with a local server |
| [Model judge](#model-judge) | Does the diff meet each acceptance criterion, match the report, keep its tests as strong? | `nomarmy validators add judge --agent <name> --model <model>` | One call to your agent a job | Yes, to that agent's vendor |

`nomarmy validators list` shows which are on and, per validator, that it also drives the trust judgment, what is sent, the vendor, and the repository opt-out. Adding Jev or a model judge turns on nomArmy's trust judgment in every repository. Setup prints this once before saving (on stderr with `--json`); the JSON saved result also includes the disclosure.

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

[Jev](https://docs.typesafe.ai) is TypeSafe's fast judgment model. It checks questions nomArmy's mechanical checks can't:

- **Do a scout's cited lines support its finding?** nomArmy checks that a citation exists; Jev reads the whole cited range against the claim. A finding that fails is marked `[JEV: ...]` in the scout's report.
- **Does a worker's report match its diff?** A contradiction ("restored check.js to base commit" beside a diff that rewrote it) raises review.

```bash
nomarmy validators add jev     # asks for your TypeSafe key without showing it; one test call
nomarmy validators test jev    # check the key still works
nomarmy validators remove jev  # off, and the saved key deleted
```

The key is saved to `~/.config/nomarmy/secrets/typesafe.key`, readable only by you, never in a config file or a registration. To keep it in an environment variable instead, set `key_env: <NAME>` under `jev:` in `~/.config/nomarmy/validators.yml`. For scripts, `nomarmy validators add jev --key-stdin` reads the key from stdin.

**What we measured** on real job records: every mismatched citation we planted was caught, and the real findings it flagged were real problems (a finding that misread its own cited line; true claims citing the wrong lines). It flagged none of 30 real reports against their own diffs and caught a worker's false claim. A job's checks cost a fraction of a cent.

**What it sends to TypeSafe:** excerpts of your code (findings, cited lines, diffs, worker reports), plus each implement job's diff and its brief at dispatch for nomArmy's trust judgment in every repository. The trust judgment checks for security-sensitive changes (access control, removed checks, personal data, secrets, money). It can only raise a job's review level. Turn it off for a repository with `trust: { judgment: false }` in its `.nomarmy.yml`. A failed or slow call (15 seconds at most) skips Jev for every job for 10 minutes, and a job never spends more than 45 seconds on it.

## Running the judgment locally

Any System One-compatible server can replace the TypeSafe endpoint, including
[Kev](https://github.com/jaredpalmer/kev). Install Kev and its model using that
project's instructions, then start its `kev.serve` module in the environment
where you installed it. For example, with port 8000:

```bash
python -m kev.serve --port 8000
nomarmy validators add kev --endpoint http://127.0.0.1:8000
# Equivalent: nomarmy validators add jev --endpoint http://127.0.0.1:8000
nomarmy validators list
nomarmy validators test jev
```

Keep the server bound to loopback. Set `--model <id>` if your server needs a
particular model id; otherwise nomArmy sends `jev-latest`. Setup makes the same
small test call as TypeSafe setup and saves only after it answers successfully.
The `kev` alias writes a `jev` entry, not a separate validator:

```yaml
jev:
  enabled: true
  endpoint: http://127.0.0.1:8000/v1/systemone
  model: jev-latest
  checks: [scout-citations, report-claims]
```

Endpoints may use HTTPS with any host. Plain HTTP is accepted only when the
host is exactly `127.0.0.1`, `::1` (written `[::1]` in a URL), or `localhost`,
with any port. A base URL gets `/v1/systemone` appended; a path already ending
in `/v1/systemone` is used directly. Credentials in URLs, query strings,
fragments, other protocols, and non-loopback HTTP are rejected. Requests do not
follow redirects. Without `endpoint`, the URL remains
`https://api.typesafe.ai/v1/systemone`.

Loopback servers need no key by default, and nomArmy sends no Authorization
header without one. If you enable Kev's optional `KEV_API_KEY`, supply the same
key with `--key-env KEV_API_KEY` or `--key-stdin`. Non-local endpoints still
require `key_env` or `key_file`. `--key-env NAME` saves only the variable name;
the server-running coordinator must inherit that variable. `--key-stdin` stores
the key in the same private key file used by TypeSafe setup.

For loopback endpoints, code excerpts, diffs and briefs go only to the local
server at the displayed endpoint; whether they go further is up to that server. For HTTPS endpoints on
other hosts, setup names the recipient host. This describes nomArmy's request;
configure the local server itself to run locally, without forwarding data.
Listings include the endpoint and whether it is local, also as `endpoint` and
`local` in `--json` output. Health warns if the local server is unavailable and
suggests its start command. Failed job checks and trust judgments remain
unavailable/error, never a pass.

**Measure accuracy before relying on a replacement.** Use representative code,
known contradictions and sensitive changes, and measure false positives and
missed flags. Protocol compatibility is not equivalent judgment quality.
Validators still only add review flags; no verdict can clear a flag or pass a
mechanical check.

**Forward compatibility:** older nomArmy versions strictly reject the new
`endpoint` field. Before open coordinator sessions read the updated file, run
`nomarmy update`, then restart those sessions so they run this version. Setup
prints this reminder whenever it writes an endpoint.


### Measure a local model before relying on it

A local server keeps your code on your machine, but it only protects you if it catches what Jev catches. We measured on 2026-10-05 with `scripts/trust-measure.mjs` against a private corpus of 14 real defects that escaped review in one of our own products and 15 harmless commits, at nomArmy's normal threshold (0.5 for review):

| Judgment | Defects caught (of 14) | False alarms (of 15) |
|---|---|---|
| None (the deterministic floor and detector only) | 1 | 0 |
| [Von](https://github.com/wfzyx/von) 1.3 (395M), local | 5 | 0 |
| [Kev](https://github.com/jaredpalmer/kev)-4B, local | 8 | 0 |
| Jev (TypeSafe) | 14 | 0 |

Neither local model separated real defects from harmless changes: their scores sat in a narrow middle band (Von 0.30 to 0.54, Kev-4B 0.2 to 0.6) that overlapped the harmless commits, so lowering the threshold only traded catches for false alarms. Larger Kev models (9B, 27B) weren't measured. One team's corpus is not a benchmark; your results will differ.

So don't swap Jev for a local model on faith. Measure it on your own history: build a corpus of diffs that introduced real defects and harmless ones (`scripts/trust-measure.mjs` documents the format), point a throwaway config at the local server, and compare:

```bash
NOMARMY_CONFIG_DIR=/tmp/local-judge node scripts/trust-measure.mjs <corpus-dir> --judgment jev
```

Some servers download their weights on the first request, which can outlast Jev's 15-second call; nomArmy reports that judgment as unavailable, never as a pass. Send one request first, or wait for the download, before measuring.

## Model judge

Jev is fast at narrow questions. For judgments that take a few steps, make one of your agents a judge:

```bash
nomarmy validators add judge --agent grok --model grok-4.7
nomarmy validators add judge --agent claude --model claude-haiku-4-5 --host-tools
nomarmy validators test judge
nomarmy validators remove judge
```

After each implement job it answers three questions about the diff, in one call: does it meet each acceptance criterion, does it match the worker's report, and did any changed test get weaker? An "unmet", "contradicts" or "weakened" answer raises review.

- **Pick an agent independent of the builders.** The terminal lists independent agents first and marks agents that use the same vendor as builders. Move to a newer model by running `add judge` again.
- **Host tools need consent.** When `nomarmy validators add judge` selects an agent whose tools run on your machine, it explains the boundary and asks for consent in an interactive terminal. The judge runs through OpenClaw in an empty folder and is told not to use tools, but OpenClaw can't turn an agent's tools off. Pass `--host-tools` to give the same consent in a scripted command. An api key, Codex or Muse agent needs none.
- **What it sends to the selected agent's vendor:** the diff, report, and acceptance criteria, plus each implement job's diff and its brief at dispatch for nomArmy's trust judgment in every repository. The trust judgment checks for security-sensitive changes (access control, removed checks, personal data, secrets, money). It can only raise a job's review level. Turn it off for a repository with `trust: { judgment: false }` in its `.nomarmy.yml`. The local model can't be a judge (too little context for a diff).

The trust judgment prefers Jev when available and otherwise uses the model judge; it does not send the same judgment to both. The repository opt-out disables diff and brief trust judgments, not the validator's other checks. A repo without trust rules gets no floor gating; the removed-check detector always runs, and the per-diff judgment runs unless `trust.judgment` is false.

**What we measured** with Claude Haiku 4.5 as judge on 12 real jobs: it flagged none against their own diffs, caught 8 of 12 reports paired with another job's diff and a worker's false claim, and never called a real job's acceptance criterion unmet (it said "unclear" when it couldn't tell). About 13 seconds a job.

## Which to use

- **Mutation testing** in repositories where the tests really matter; it's free apart from time, and nothing leaves your machine.
- **Jev** for fast, cheap checks on every job, if sending excerpts to TypeSafe is acceptable.
- **A judge** for acceptance criteria and test weakening, on a sandboxed agent from a different vendor than your workers.
