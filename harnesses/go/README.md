# Go harness

Go toolchain with prefetched modules for offline verification.

## Detection

Matches `go.mod` or `go.work` at the repository root.

## Installed today

Installs Go 1.27.1 from the upstream tarball for amd64 or arm64, on the Node 24 Debian bookworm base with Python 3 and pip. Sets GOPATH for the node user.

At image build, copies root `go.mod` and `go.sum` (when present), plus `go.work`, `go.work.sum` and each repository-contained workspace module’s manifests. Runs `go mod download` as node into the default module cache, `/home/node/go/pkg/mod`. Repositories with `vendor/` skip this download. A failed download leaves `/deps/go/.nomarmy-go-mod-download-failed` without failing the image build. Runtime sets `GOPROXY=off` and `GOSUMDB=off`; no `GOFLAGS` override is set, preserving Go’s default module behavior. Copied metadata is hashed into the image tag, so dependency changes rebuild the cache. The layer composes with Node dependencies in mixed repositories.

## Verification and network

Proposes `go test ./...` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Remaining limitations

Private modules and registries need build-only credentials, planned in [step 8](../../docs/plans/2026-09-25-sandbox-dependencies.md#steps); no credentials are copied into the image. A failure marker means the cache may be incomplete and offline verification can still fail. Workspace modules and local replacements outside the repository are not copied.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
