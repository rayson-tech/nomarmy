# Plan: every ecosystem's dependencies in the sandbox

**Status: queued.** Starts after the desktop and cloud app work.

## Why

A job's sandbox has no network, so a repo's dependencies must already be in the image it runs in. nomArmy builds that image on the host, where there is network, keyed by a hash of the lockfile, and every job and verification then runs offline against it (`lib/sandbox-images.mjs`). Today that covers less than the docs suggest:

| Ecosystem | Installed today | Gap |
|---|---|---|
| Node | each package's `package-lock.json`, via `npm ci` | pnpm, yarn, bun, workspaces |
| Python | `requirements.txt`, or files listed in `environment.python.requirements` | `pyproject.toml`, uv, poetry |
| Go | the toolchain only (`docker/Dockerfile.go`) | **no modules**: a repo with external dependencies fails offline unless it vendors them |
| Rust | the toolchain only (`docker/Dockerfile.rust`) | **no crates**: same |
| Mixed repos | the first match in `detectPrimaryLanguage` (Go, then Rust, then Python/Node) | a Go backend with a Node frontend loses the Node dependencies |
| Private registries | none, in any ecosystem | the image build has no credentials |
| Java, .NET, Ruby | none | |

The Go and Rust gaps fail silently: verification fails and looks like a code problem. The README's status table ("Go and Rust toolchains live-verified") is true only for dependency-free repos; correct it in step 1.

## Design: one dependency image, one layer per ecosystem

Replace first-match language images with a single per-repo image composed from every ecosystem the repo has:

- **Base:** today's `node:24-bookworm-slim` plus apt tools.
- **Toolchain layers:** Go and Rust when their manifests exist (from today's static Dockerfiles, so a toolchain layer is shared across repos by Podman's cache).
- **Dependency layers,** each copying only its manifests and lockfiles (build context from the worktree, as the npm path does), then prefetching offline-usable artifacts:
  - Go: `go.mod`, `go.sum` → `go mod download` into `GOMODCACHE`; at run time `GOFLAGS=-mod=mod`, `GOPROXY=off`.
  - Rust: `Cargo.toml`, `Cargo.lock` and every workspace member's `Cargo.toml` → `cargo fetch --locked`; at run time `CARGO_NET_OFFLINE=true`.
  - Node: per package manager, below.
  - Python: requirements files, or `pyproject.toml` with `uv.lock` (`uv sync --frozen`) or `poetry.lock` (`poetry install --no-root`).
- **Tag:** a hash of every copied file plus the layer recipe, as today; any lockfile change is one rebuild, and then cached.
- **A layer that can't install** (a private registry, a broken lockfile) leaves a marker and the rest of the image still builds, as the npm path does now. Verification then reports that ecosystem's install failure by name instead of failing on a missing import.

`detectPrimaryLanguage` becomes `detectEcosystems` (a list). `EXEC_PATH_PREPEND` and the per-job OpenClaw sandbox override (`resolveWorkerSandboxOverride`) take the union.

## Steps

Each step is its own PR with tests; image builds are stubbed in unit tests (`sandboxImageRun`), and one live repo per ecosystem is the end-to-end check.

1. **Go and Rust dependencies.** Prefetch layers as above, offline run-time settings, tests against fixture repos with a real external module and crate. Correct the README status row. *Small; the highest value, because it fixes repos that fail today.*
2. **Composed images for mixed repos.** `detectEcosystems`, one image with a layer per ecosystem, a union of exec paths. A Go + Node fixture repo verifies with both. *Medium.*
3. **pnpm, yarn, bun and workspaces.** Detect by lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`/`bun.lock`) and install with that tool's frozen-lockfile command (`corepack` provides pnpm and yarn). Workspaces install once at the root. The hard part: pnpm's symlinked `node_modules` must resolve from the worktree, so link the whole root `node_modules` plus each workspace package's, and test that `require` resolves from a nested package. *Medium.*
4. **Python via `pyproject.toml`, uv, poetry.** `uv sync --frozen` for `uv.lock` and plain `pyproject.toml`; poetry's lockfile install for `poetry.lock`. Update `propose.mjs`, which today proposes only pip. *Medium.*
5. **Private registries.** Credentials reach the image **build** only, as `podman build --secret`, never a layer, never the sandbox, never a job's environment. Sources: the host's own `.npmrc`, pip `index-url`, `GOPRIVATE` plus `.netrc`, cargo `credentials.toml`, declared by path in `.nomarmy.local.yml` (never the committed file). A test proves no secret appears in `podman history` or the image filesystem. *Medium to high; needs a security review before merging.*
6. **Java, .NET, Ruby, on demand.** A toolchain layer plus a prefetch: `mvn dependency:go-offline`, Gradle with a warmed cache (its offline mode is unreliable; test it on a real repo before promising it), `dotnet restore`, `bundle install --deployment`. *Medium each; build when a user needs one.*

## Out of scope

- Network at run time for jobs, even allowlisted. Offline at run time is the boundary that keeps repository content away from credentials.
- Services a test needs (a database, a mock server): tracked separately as disposable per-job services.
