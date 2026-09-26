# Rust harness

Rust toolchain only; crate prefetch is not yet supported.

## Detection

Matches `Cargo.toml` at the repository root.

## Installed today

Installs stable Rust through rustup with its minimal profile, plus build-essential, on the Node 24 Debian bookworm base with Python 3 and pip. Cargo and rustup live under the node user.

Toolchain only: there is no crate prefetch yet. External crates are not downloaded before offline verification. Mixed-repo image composition is not implemented.

## Verification and network

Proposes `cargo test` as the `quick` profile. Network level: `none`. This registry is metadata only; it does not change image building, jobs, or verification.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
