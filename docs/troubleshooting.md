# Troubleshooting

| Symptom | Fix |
|---|---|
| Anything unclear about the machine | `nomarmy doctor`, then `nomarmy health` |
| `No API key found for provider "llama-cpp"` during `e2e.sh` | `./scripts/configure-openclaw.sh <profile>`, then rerun |
| A job fails with `model_not_found` | Your plan or OpenClaw can't run that model. `nomarmy agents list` shows which roles use it; `nomarmy army assign <role> <agent> <model>` moves the role and tests the new model |
| Verification fails on a missing package | Node: commit each package's `package-lock.json` (yarn, pnpm and workspaces aren't installed yet). Python: list your requirements files under `environment.python.requirements` |
| A config change didn't take effect | `nomarmy stop && nomarmy start` for inference; restart your coordinator after `nomarmy connect` or an update |
| `git worktree add` fails with `Filename too long` (Windows/WSL2) | `git config --global core.longpaths true` |
| Not sure a setting fits your hardware | `nomarmy sizing`, or `nomarmy sizing --check` |
