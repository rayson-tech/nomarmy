# Node harness

Node dependencies installed with npm ci.

## Detection

Matches `package-lock.json` at the root or in npm package directories found by the existing Node discovery.

## Installed today

Installs each supported npm package with `npm ci --no-audit --no-fund` under `/deps` at image build time. The base is Node 24 on Debian bookworm. A failed install leaves `.nomarmy-npm-ci-failed`. Root dependencies and nested packages are linked for sandbox resolution.

Only npm lockfiles are supported today. npm workspaces, pnpm, yarn, and bun installs are not supported.

## Verification and network

Proposes `npm test` as the `quick` profile. Network level: `none`. This registry is metadata only; it does not change image building, jobs, or verification.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
