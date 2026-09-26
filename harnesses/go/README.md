# Go harness

Go toolchain only; module prefetch is not yet supported.

## Detection

Matches `go.mod` at the repository root.

## Installed today

Installs Go 1.27.1 from the upstream tarball for amd64 or arm64, on the Node 24 Debian bookworm base with Python 3 and pip. Sets GOPATH for the node user.

Toolchain only: there is no module prefetch yet. Offline verification with external dependencies needs vendored modules. The Go toolchain layer composes with other matched harnesses, including Node dependencies in mixed repositories.

## Verification and network

Proposes `go test ./...` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
