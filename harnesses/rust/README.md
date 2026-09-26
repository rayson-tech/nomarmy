# Rust harness

Rust toolchain with prefetched crates for offline verification.

## Detection

Matches `Cargo.toml` at the repository root.

## Installed today

Installs stable Rust through rustup with its minimal profile, plus build-essential, on the Node 24 Debian bookworm base with Python 3 and pip. Cargo and rustup live under the node user.

At image build, copies root and nested `Cargo.toml` files through four directory levels, excluding `target/` and dot folders, plus root `Cargo.lock` when present. The isolated build context includes placeholder library and binary sources and explicit target paths so Cargo can parse packages without copying application code. Runs `cargo fetch` as node (`--locked` when the lockfile exists), caching crates under `/home/node/.cargo`. A failed fetch leaves `/deps/rust/.nomarmy-cargo-fetch-failed` without failing the image build. Runtime sets `CARGO_NET_OFFLINE=true`. All copied manifests, the lockfile and generated targets contribute to the image tag. The layer composes with other matched harnesses.

## Verification and network

Proposes `cargo test` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Remaining limitations

Private modules and registries use the build-only credentials described below; no credentials are copied into the image. A failure marker means the cache may be incomplete and offline verification can still fail. Workspace members and path dependencies outside the repository or deeper than four directories are not copied. Root `.cargo/config` and `.cargo/config.toml` are copied as credential-free registry metadata; unusual manifests may require additional target handling.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.


## Private registries

Use `registries:` in the gitignored `.nomarmy.local.yml` only; the committed
config rejects it. Values are host credential **file paths**, never tokens.
Use `cargo: ~/.cargo/credentials.toml`. Only `cargo fetch` receives the node-owned secret mount. Configure registry names/index URLs without tokens in project metadata.

Credentials stay on the host and enter Podman only as build-secret mounts;
no credential files are copied into the context or passed to sandbox jobs.
Use a **read-only, least-privilege token** and reviewed dependencies. Secrets
are accessible to install code during that RUN, so malicious packages are not
made safe by a mount. Credential rotation invalidates both tag and install
cache. Credentialed install output/build-error details are withheld.

See [Private registries](../../docs/your-repo.md#private-registries) for the
configuration and required manual canary check: inspect `podman history
--no-trunc`, image configuration, the exported filesystem **and every saved
image layer**, plus failure logs/job records, for absent secret bytes. Unit
tests stub Podman; live isolation needs independent security review.
