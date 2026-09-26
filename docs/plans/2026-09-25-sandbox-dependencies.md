# Plan: harnesses, and every ecosystem's dependencies in the sandbox

**Status: steps 1 to 9 done** (PRs #50, #52 to #54, #60 to #64); step 10 is on demand. Replaces this file's earlier dependencies-only plan: languages turn out to be the first case of a general idea, the harness.

## Why

A job's sandbox has no network, so what a repo needs to build and test must already be in the image it runs in. nomArmy builds that image on the host, where there is network, keyed by a hash of the lockfiles, and every job and verification (including `mode: verify`) then runs offline against it (`lib/sandbox-images.mjs`). Today that covers less than the docs suggest:

| Ecosystem | Installed today | Gap |
|---|---|---|
| Node | each package's `package-lock.json`, via `npm ci` | pnpm, yarn, bun, workspaces |
| Python | `requirements.txt`, or files listed in `environment.python.requirements` | `pyproject.toml`, uv, poetry |
| Go | the toolchain only (`docker/Dockerfile.go`) | **no modules**: a repo with external dependencies fails offline unless it vendors them |
| Rust | the toolchain only (`docker/Dockerfile.rust`) | **no crates**: same |
| Mixed repos | the first match in `detectPrimaryLanguage` | a Go backend with a Node frontend loses the Node dependencies |
| Private registries | none, in any ecosystem | the image build has no credentials |
| Browsers, mobile, anything else | none | |

The Go and Rust gaps fail silently: verification fails and looks like a code problem. The README's status row ("Go and Rust toolchains live-verified") holds only for dependency-free repos; correct it in step 2.

Every row has the same shape: *detect it from the repo, install it at image build, add a verification profile*. That shape is the harness.

## Harnesses

A harness is a folder. Adding one never touches core code or the README.

```
harnesses/
  node/                  built in: the ecosystems are harnesses too
  go/
  browser-playwright/    the first "contributed" one
    harness.yml          what it is and what it needs (data only)
    README.md            its own docs
    fixture/             a tiny repo that proves it works
  _template/             copy this to start a new one
```

### `harness.yml`

Validated with zod, like `.nomarmy.yml`. Data only; no code runs from it except its build commands, at image build.

```yaml
name: browser-playwright
summary: Headless Chromium through Playwright
detect:                        # when it applies (any match)
  - package: "@playwright/test"  # a Node dependency
  - file: playwright.config.ts
after: [node]                  # layers it builds on
image:                         # at image build only, with network
  apt: [ ... ]
  run:
    - npx playwright install --with-deps chromium
verification:                  # profiles it proposes to `nomarmy init`
  browser: npx playwright test
artifacts:                     # kept in the job record as evidence
  - test-results/**
  - playwright-report/**
requires:                      # checked by `nomarmy doctor`
  memoryMb: 1024
  shmMb: 512
network: none                  # none | services | allowlist (see below)
services: []                   # fake services it runs next to the app
suggestedRole:                 # optional; `nomarmy init` can offer it
  name: browser-qa
  description: Runs the browser suite and reviews its screenshots.
```

What the schema refuses: extra mounts, host paths, privileged mode, capabilities, credentials in the file, and `network` above what the operator allows (below).

### How the pieces use it

- **Registry** (`lib/harnesses.mjs`): loads and validates every harness folder at startup, like agents.yml; a broken harness is reported and skipped, never half-loaded.
- **Image builder:** one image per repo, composed of a layer per matching harness in `after` order, tagged by a hash of the files each layer copies plus its recipe. A layer that can't install leaves a marker; the rest still builds and verification names the failed harness.
- **`nomarmy init`:** proposes the matching harnesses' profiles and suggested roles.
- **`army` and `local_worker_config`:** list the harnesses a repo matches, their profiles and their network level.
- **Jobs:** implement and `mode: verify` run a harness's profile like any other; `artifacts` are copied into the job folder and listed in the record, so the General can read a screenshot rather than a claim.
- **Docs:** the README links once to `docs/harnesses.md`, generated from every `harness.yml` (a row per harness: summary, network level, requirements, link to its README). `npm run docs:harnesses` regenerates it and CI fails if it's stale. A contributor adds a folder, runs one command, opens a PR.

## Network: a ladder, not a switch

"No network" protects the **worker**: the part steered by an LLM and by repository content, and so the part that could be talked into sending code or credentials somewhere. It stays absolute for workers. Verification can climb one rung at a time, and each harness declares the lowest rung it needs:

1. **`none`** (default): most tests.
2. **`services`**: the harness runs fake services beside the app on a private Podman network with no route out: a mock OIDC server or Keycloak for Okta/Auth0-style logins, stripe-mock, WireMock. Covers a lot, provided the app reads endpoints from config.
3. **`allowlist`**, verification only, never the worker, for apps that need the real service (hard-coded endpoints, flows no mock covers):
   - the operator opts in per host in `.nomarmy.local.yml` (never the committed file, so a repo can't grant itself network), e.g. `dev-12345.okta.com`;
   - traffic goes through a proxy that allows only those hosts (Podman can't filter by domain on its own);
   - test credentials come from the host's environment into that run only;
   - the job record states it: "verification had network access to dev-12345.okta.com".
   Residual risk: verification runs worker-written code with a test credential and a route to the allowed host, which a determined exploit could abuse. So: **a dedicated test tenant with throwaway credentials, never production**, and the docs say so.
4. **Outside nomArmy:** the operator's CI, or the General on the host after review and merge. A legitimate answer, not a failure.

## Steps

Each step is its own PR with tests; image builds are stubbed in unit tests (`sandboxImageRun`), and each harness's `fixture/` is its end-to-end check (run live before merging, and by `mode: verify`).

1. **The harness format and registry.** `harness.yml` schema, `lib/harnesses.mjs`, `_template/`, the generated `docs/harnesses.md` with its CI check, and the image builder composing layers from harnesses. Port today's Node (npm) and Python (requirements) support into `harnesses/node` and `harnesses/python` with no behavior change. *Medium; everything after builds on it.*
2. **Go and Rust as harnesses, with dependencies.** `go mod download` (then `GOFLAGS=-mod=mod`, `GOPROXY=off` at run time) and `cargo fetch --locked` over every workspace member (then `CARGO_NET_OFFLINE=true`). Fixture repos with a real external module and crate. Correct the README status row. *Small; the highest value, since it fixes repos that fail today.*
3. **Mixed repos.** Falls out of step 1's composition: a Go + Node fixture verifies with both.
4. **pnpm, yarn, bun and workspaces** in `harnesses/node`: detect by lockfile, install with the tool's frozen-lockfile command (`corepack` for pnpm and yarn), workspaces once at the root. The hard part: pnpm's symlinked `node_modules` must resolve from the worktree, so link the root's plus each workspace package's, and test `require` from a nested package. *Medium.*
5. **Python via `pyproject.toml`, uv, poetry** in `harnesses/python`: `uv sync --frozen`, poetry's lockfile install; `propose.mjs` stops proposing only pip. *Medium.*
6. **`browser-playwright`, the first harness built the way a contributor would.** Chromium via `npx playwright install --with-deps chromium` pinned to the lockfile's Playwright, `--disable-dev-shm-usage` or a larger `/dev/shm`, the `browser` profile, screenshots and traces as artifacts. Optional in practice: most of the time the General checks UI itself, after merging; this is for repos with a real e2e suite as the acceptance gate, UI roles checking their own work, or parallel UI jobs. *Medium.*
7. **`services`: fake services on a private network.** Podman `--internal` network, service containers declared by a harness, health-checked before the profile runs. First: a mock OIDC provider. **Implemented:** explicit `.nomarmy.yml` harness selection, pinned service specs and non-secret env, bounded discovery health checks, finally cleanup, and stubbed Podman lifecycle tests. Workers remain offline. Live fixture proof still required before merge.
8. **Private registries.** Credentials reach the image **build** only, as `podman build --secret`: never a layer, never the sandbox, never a job's environment. Sources declared by path in `.nomarmy.local.yml`. A test proves no secret appears in `podman history` or the image. *Medium to high; security review before merging.*
9. **`allowlist` network for verification.** **Implemented (pending independent security review and live Podman proof):** operator-local, gitignored host/port opt-in; built-in HTTP/CONNECT proxy with DNS address pinning and private-address refusal; dual-network non-root proxy with internal-only verification; verification-only host-env credentials and output redaction; network authority and verdict logs in job records. In-process proxy and stubbed Podman tests cover denial and cleanup. Workers remain offline. *High; security review before merging.*
10. **More harnesses, on demand and from contributors:** Java (Maven's `dependency:go-offline`; Gradle only with a warmed cache, tested on a real repo first), .NET (`dotnet restore`), Ruby (`bundle install --deployment`), an Android emulator (`requires: kvm`; Linux hosts only, not Podman's macOS VM). iOS simulators can't run in a Linux container at all; a harness can say so rather than fail strangely.

## Out of scope

- Network for workers, at any rung.
- Running a harness's code at job run time with network: installs happen at image build.
