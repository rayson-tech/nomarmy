# Node harness

Node dependencies and workspaces installed with npm, pnpm, yarn or bun.

## Detection

Matches `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `bun.lockb` at the root or in discovered package directories.

## Installed today

Installs dependencies as the `node` user under `/deps` at image build time, on Node 24 / Debian bookworm:

- npm: `npm ci --no-audit --no-fund` (unchanged).
- pnpm: Corepack and `pnpm install --frozen-lockfile`.
- Yarn classic: Corepack and `yarn install --frozen-lockfile`.
- Yarn Berry: detected by `.yarnrc.yml` or lockfile `__metadata`; `YARN_NODE_LINKER=node-modules yarn install --immutable`.
- Bun: installed globally at build time, then `bun install --frozen-lockfile`.

Corepack respects `packageManager` in the manifest. Without a pin, Yarn defaults to classic or current stable Berry according to detection. Failed installs leave `.nomarmy-npm-ci-failed` for npm or `.nomarmy-<manager>-install-failed` for other managers (`yarn-berry` for Berry).

A manifest's `workspaces` array (or `workspaces.packages`) or `pnpm-workspace.yaml` causes one install at that workspace root. Member manifests are copied at their relative paths, including members without their own lockfile; workspace members are not installed twice. Workspace globs support `*`, `**`, `?`, brace alternatives and exclusions. Non-workspace packages retain separate installs.

Root dependencies resolve through `/node_modules`; workspace roots and members also receive worktree links into `/deps`, preserving pnpm's relative store links. The root binary PATH remains `/deps/node_modules/.bin`. Copied manifests, lockfiles and workspace/config files participate in the image tag.

Private registries are not supported yet: image builds have no registry credentials (dependency plan step 8).

## Verification and network

Proposes `npm test` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
