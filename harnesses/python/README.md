# Python harness

Python dependencies installed from requirements files.

## Detection

Matches `requirements.txt` at the repository root.

## Installed today

Installs Python 3, pip, venv, and build-essential alongside the Node 24 base. Runs `pip3 install --no-cache-dir --break-system-packages` at image build time.

Uses `requirements.txt` by default. Set `environment.python.requirements` in `.nomarmy.yml` to select other or multiple requirements files. Registry detection only checks `requirements.txt`; it does not read this configuration. pyproject.toml, uv, and poetry installs are not supported today.

## Verification and network

Proposes `python3 -m unittest discover` as the `quick` profile. Network level: `none`. This registry is metadata only; it does not change image building, jobs, or verification.

## Requirements and artifacts

No additional resource requirements or artifact globs are declared.
