# Python harness

Python dependencies from uv, Poetry, pyproject, or requirements files.

## Detection

Matches `uv.lock`, `poetry.lock`, `pyproject.toml`, or `requirements.txt` at the repository root. Explicit `environment.python.requirements` in `.nomarmy.yml` wins; otherwise the install precedence is uv.lock, poetry.lock (or `[tool.poetry]`), `[project]` in pyproject.toml, then requirements.txt.

## Installed dependencies

Installs Python 3, pip, venv, and build-essential alongside the Node 24 base. Dependency downloads happen at image build time, not in the offline sandbox.

- **uv:** installs uv and runs `uv sync --frozen --no-install-project --all-groups`, including dev groups, from the copied pyproject.toml and uv.lock.
- **Poetry:** installs Poetry and runs `poetry install --no-root --no-interaction` from pyproject.toml and poetry.lock when present. Adds `--with dev` only when a Poetry dev group exists. Legacy dev dependencies follow Poetry's default behavior.
- **Plain pyproject:** uses Python's TOML parser to install `[project].dependencies` and optional `test`, `tests`, and `dev` dependencies with pip, without installing the project itself. A lockfile makes dependency resolution reproducible; unlocked pyproject dependencies may resolve differently on rebuild.
- **Requirements:** retains the existing system `pip3 install --no-cache-dir --break-system-packages` path. Uses requirements.txt by default; set `environment.python.requirements` to select other or multiple files. Explicit requirements also activate composition without a registry detect match.

The project-manager paths share `/deps/python/.venv`. `VIRTUAL_ENV` is set, and its bin directory comes first in both the image PATH and worker exec PATH. Install failures leave `/deps/python/.nomarmy-<manager>-install-failed` (uv, poetry, or pyproject) instead of failing the image build. Copied manifests and lockfiles are hashed into the image tag. Local/path dependencies and workspace members not included in the root metadata context may require an explicit requirements configuration.

## Verification and network

The registry proposes `python3 -m unittest discover` as the `quick` profile. Config proposals use test commands found in evidence, or suggest `pytest` for project manifests; review that pytest is declared and appropriate. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. Verification profiles are proposals; the registry does not change job profiles or network access.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.


## Private registries

Use `registries:` in the gitignored `.nomarmy.local.yml` only; the committed
config rejects it. Values are host credential **file paths**, never tokens.
pip uses `/etc/pip.conf`; for uv or Poetry use `pip: { netrc: ~/.netrc }` and credential-free index/source URLs in project metadata. The secret is mounted only for the root-owned install RUN, including venv installs.

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
