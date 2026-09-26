# Harness name

Write a short summary of what this harness provides.

## Detection

List the markers and packages that match. Explain any `after` layers.

## Installed today

List tools and dependencies, versions, build commands, and known gaps.

## Verification and network

Document each proposed profile. Declare the lowest network level needed.
For allowlist verification, document operator opt-in and dedicated test tenants
with throwaway credentials, never production. Workers always remain offline.
This registry does not enable services or allowlist networking yet.

## Requirements and artifacts

Explain memory, shared memory, KVM, and artifact globs, if any.

## Fixture

Add a tiny repository under `fixture/`. Describe how to verify it and its
expected results. Keep credentials and host-specific paths out of fixtures.
