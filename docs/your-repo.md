# Your repository

## `.nomarmy.yml`

A repo's execution contract: its verification profiles and, optionally, its army and dependency settings. `nomarmy init` proposes one from what it finds (compose files, CI steps, requirements files, test commands) and writes it only after you confirm. nomArmy reads it from your checkout, never from a job's worktree, so a worker can't weaken its own checks.

```yaml
verification:
  quick:
    environment: none
    commands:
      - npm test
```

`nomarmy validate` checks the file against the schema; `nomarmy scan --check` diffs it against what the repo actually contains.

**Policy: what no job can skip.**

```yaml
policy:
  require_verification: true       # every implement job needs a verification profile; only passing work commits
  require_regression_check: true   # verify_regression can't be switched off per job
```

`nomarmy init` proposes both for new repos. Without them, a job with no verification profile still commits (flagged for review, not blocked), and the General decides per job whether to run the revert check. With them, those are the repo's rules, not the General's judgment calls, and since nomArmy reads this file only from your checkout, neither the General nor a worker can relax it.

**Refactors.** Reverting a behavior-preserving change restores code that works, so the revert check can't prove anything about it. A job can declare `refactor: true` instead: nomArmy then commits it only if verification passes **and no test file was added, changed or deleted**. The existing tests passing unchanged is the evidence. A change that alters behavior has to alter tests to show it, so it can't pass as a refactor.

**Add a check for what unit tests can't see.** A module left out of a deploy bundle passes every unit test and crashes at deploy. When `nomarmy init` sees a bundle or packaging step (Lambda asset scripts, SAM, Serverless, CDK), it suggests a profile that runs it and then imports each entry point from the built bundle.

## Languages and dependencies

See the [harness registry](harnesses.md) for ecosystem detection, network levels, and requirements. Matched harnesses supply image layers and verification requirements.

The sandbox has no network, so dependencies are installed when its image is built, on your machine, and the image is cached by a hash of the dependency files.

| Repo | Detected by | Sandbox |
|---|---|---|
| Node | every package with its own `package-lock.json` or `npm-shrinkwrap.json`: the root, and any others (a `ui/`, a `lambda/api/`) | `npm ci` for each at build time, under `/deps` at the same path. The root's packages are at `/node_modules`; each other package gets a `node_modules` link into the image, which nomArmy never commits |
| Python | `requirements.txt`, or `environment.python.requirements` | `pip install` at build time |
| Both | both of the above | one image with both |
| Go, Rust | `go.mod`, `Cargo.toml` | the toolchain, built once and cached |
| anything else | | the base image: Node, Python 3, git, ripgrep |

The worker's own tool calls and nomArmy's verification use the same image. `NOMARMY_AGENT_IMAGE` overrides detection, and `environment.node.install: false` turns the Node install off.

```yaml
environment:
  python:
    requirements:
      - requirements-dev.txt
      - lambda/requirements.txt
```

A package whose install fails (a private registry, say) is marked and skipped; the rest still install. npm workspaces, yarn, pnpm and bun aren't installed yet. For those repos, verification borrows your own checkout's `node_modules` read-only, which works for plain JavaScript packages but not for ones with native binaries built for your host.

## Scoping verification to the diff

A command scoped by a hand-maintained filter (`pytest -k`) can silently skip the file a worker changed. Every verification command gets two variables to scope by instead:

| Variable | Contents |
|---|---|
| `NOMARMY_CHANGED_TEST_FILES` | New and modified test files, space-separated |
| `NOMARMY_CHANGED_PRODUCTION_FILES` | Non-test files touched, space-separated |

```yaml
verification:
  python:
    commands:
      - 'if [ -n "$NOMARMY_CHANGED_TEST_FILES" ]; then python3 -m pytest $NOMARMY_CHANGED_TEST_FILES -q; fi'
      - 'if [ -n "$NOMARMY_CHANGED_PRODUCTION_FILES" ]; then python3 -m pytest lambda/tests/ -q; fi'
```

Run the narrow pass on the touched files for a fast, sharp signal, *and* the broad pass whenever production code changed: a shared module can have far more dependents than the files a diff happens to touch. Running the changed tests on their own also catches a test that only passes inside the full suite.

## What else nomArmy checks

- **Tests that prove nothing.** With `verify_regression` (on whenever a job has a verification profile), nomArmy reverts the production change and re-runs the tests: a test that still passes is flagged.
- **Tests made to pass.** New skip markers, stubbed imports, fake modules named like a dependency, and stray backup files are flagged for review.
- **Code wired to nothing.** A new function or class that nothing outside its own test calls is flagged (heuristic and review-only).
- **Secrets.** Every diff and report is scanned for known secret shapes (secretlint's recommended preset) before a commit is allowed; a match blocks it.

## Browser verification and evidence

For a repository with a real Playwright end-to-end gate, select the `browser`
profile (`npx playwright test`). The browser-playwright harness installs the
repository's matching Chromium version and declares 1024 MB memory / 512 MB
shared memory. See [the browser harness](../harnesses/browser-playwright/README.md)
for offline setup and OpenClaw's `--disable-dev-shm-usage` launch option.
Usually the General checks UI changes itself after merging.

After independent implement verification and `mode: verify`, matching
`test-results/**` and `playwright-report/**` files (including screenshots and
traces) are copied into the job's `artifacts/` directory. Job records list
job-relative paths in `verification.artifacts`. Collection skips symlinks and
is capped at 200 files / 50 MB; `verification.artifactsCapped` and the detail
report when the cap is reached.

## Opt-in harnesses

Use the top-level `harnesses` list to enable registry harnesses in addition to
those detected from your repository:

```yaml
harnesses: [mock-oidc]
verification:
  auth:
    commands: [npm test]
```

Unknown names are refused with the available registry list. A `services`
harness runs its pinned fake services on a private, internal Podman network
only during nomArmy verification, with bounded health checks and cleanup.
Its non-secret `env` values are exported to the verification container; see
[mock-oidc](../harnesses/mock-oidc/README.md) for issuer configuration.
No ports are published and workers stay offline (`--network none`).
`allowlist` harnesses cannot be enabled by committed `.nomarmy.yml`; that rung
requires the operator-local opt-in described below.

## Verification-only external services

Prefer the offline `services` harnesses. If a test genuinely needs a real
external service, opt in from your coordinator checkout's **untracked,
gitignored `.nomarmy.local.yml`**, never the committed `.nomarmy.yml`:

```yaml
verification_network:
  allow: [dev-12345.okta.com, api.stripe.com:443]
  env:
    OKTA_CLIENT_SECRET: NOMARMY_TEST_OKTA_SECRET
```

Set `NOMARMY_TEST_OKTA_SECRET` in the host environment before running nomArmy.
YAML contains variable **names**, never credential values. Restart the
coordinator after changing the local policy: authority is snapshotted when the
verification runner is created, never read from a worker's worktree. A missing
or empty source variable makes verification `not_run`, naming that variable.

**Use a dedicated test tenant with throwaway credentials, never production.**
Verification executes worker-written code, which can abuse the test credential
or send data to an allowed destination. Exact hostnames and ports restrict the
route, not what that remote service permits. With credentials in use, command
stdout/stderr are **withheld by default**, including failure details. The log
retains exit codes, timing, and proxy verdicts. Operator-local
`verification_network.keep_output: true` restores redacted output (literal,
base64/base64url, hex, and percent-encoded credentials); arbitrary transformed
output cannot be reliably redacted.

Credentialed commands run against a disposable copy of the worktree, deleted
after verification. Test writes cannot enter the worker's worktree or a commit.
Artifacts are collected from that copy; files containing credential bytes or
the encodings above are dropped with a note. The job record includes
`verification.network.reached` (successfully connected host:port pairs) alongside
the allowlist, including regression-check reruns whose verdict logs are merged
into the job log.

An omitted port means 443; specify `:80` explicitly for HTTP. Wildcards, IP
literals, localhost and private names are refused. The proxy resolves each
request itself, rejects any answer containing private/loopback/link-local or
metadata addresses, and connects directly to the checked address. It does not
follow redirects on behalf of tests: each new destination needs its own entry.

Only the proxy joins an external network. Verification stays on its per-run
internal network, with HTTP(S) proxy variables in both cases and `NO_PROXY` for
service aliases. Tools that ignore proxies cannot reach the internet. The proxy
runs non-root with all capabilities dropped and no-new-privileges, using the
base sandbox image; that image must already be installed. Networks and
containers are removed after the run, including failures. Workers remain on
`network none`; test credentials reach neither workers, image builds nor the
proxy. The job's verification record lists allowed host:ports and credential
variable names, includes a network-access issue line, and retains proxy target
verdicts (never request payloads) in the verification log. An incomplete audit
log (including the 4 MiB capture limit or a log write failure) makes verification
`not_run`, never a silent pass.

This security boundary requires independent security review before merge;
stubbed tests are not a substitute for live Podman topology proof.
