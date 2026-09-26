# Node harness

Node dependencies installed with npm ci.

## Detection

Matches `package-lock.json` at the root or in npm package directories found by the existing Node discovery.

## Installed today

Installs each supported npm package with `npm ci --no-audit --no-fund` under `/deps` at image build time. The base is Node 24 on Debian bookworm. A failed install leaves `.nomarmy-npm-ci-failed`. Root dependencies and nested packages are linked for sandbox resolution.

Only npm lockfiles are supported today. npm workspaces, pnpm, yarn, and bun installs are not supported.

## Verification and network

Proposes `npm test` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
