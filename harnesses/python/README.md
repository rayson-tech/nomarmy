# Python harness

Python dependencies installed from requirements files.

## Detection

Matches `requirements.txt` at the repository root.

## Installed today

Installs Python 3, pip, venv, and build-essential alongside the Node 24 base. Runs `pip3 install --no-cache-dir --break-system-packages` at image build time.

Uses `requirements.txt` by default. Set `environment.python.requirements` in `.nomarmy.yml` to select other or multiple requirements files. Registry detection checks `requirements.txt`; image composition also includes Python when requirements are configured explicitly. pyproject.toml, uv, and poetry installs are not supported today.

## Verification and network

Proposes `python3 -m unittest discover` as the `quick` profile. Network level: `none`. Matched harnesses compose the sandbox image used by workers and verification. The verification profile is a proposal; the registry does not change job profiles or network access.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
