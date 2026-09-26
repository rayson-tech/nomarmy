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

Private registries use operator-local build secrets; see the configuration and Yarn Berry limitation below.

## Verification and network

Proposes `npm test` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.


## Private registries

Use `registries:` in the gitignored `.nomarmy.local.yml` only; the committed
config rejects it. Values are host credential **file paths**, never tokens.
npm, pnpm, Yarn Classic and bun read the mounted `.npmrc` as node (uid 1000). Credentialed Yarn Berry builds are currently rejected because Berry does not read `.npmrc`.

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
