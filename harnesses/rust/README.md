# Rust harness

Rust toolchain only; crate prefetch is not yet supported.

## Detection

Matches `Cargo.toml` at the repository root.

## Installed today

Installs stable Rust through rustup with its minimal profile, plus build-essential, on the Node 24 Debian bookworm base with Python 3 and pip. Cargo and rustup live under the node user.

Toolchain only: there is no crate prefetch yet. External crates are not downloaded before offline verification. The Rust toolchain layer composes with other matched harnesses in mixed repositories.

## Verification and network

Proposes `cargo test` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
