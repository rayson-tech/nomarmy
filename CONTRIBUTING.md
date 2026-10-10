# Contributing to nomArmy

## Getting set up

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
npm install
npm test
```

`npm test` runs the full suite (`node --test tests/*.test.mjs`) against plain Node built-ins: no services, no network, no local model, no Podman. On native Windows the suite runs every command in-process (`NOMARMY_WINDOWS_ENGINE=native`, set by `tests/helpers/isolate-global-config.mjs`) rather than forwarding it into WSL; tests that need file symlinks skip without Windows Developer Mode, and tests that run `python3` 3.11+ skip without it. That's the bar for a passing PR. If your change touches something only reachable with a real local model and sandbox running (`local_worker`/`local_workers` themselves, `nomarmy setup`/`init` end to end), say so in the PR description and how you tested it manually; CI can't exercise that path.

## Before opening a PR

- Run `npm test`; it must pass.
- Keep the change scoped to what you're fixing or adding. A bug fix doesn't need surrounding cleanup.
- Add or update a test for the behavior you changed. `tests/*.test.mjs` is organized roughly one file per `lib/*.mjs` module; put a new test next to the code it covers.
- If you touched `mcp/server.mjs` and are testing against a real Claude Code or Codex session locally, remember the running MCP process needs `nomarmy connect claude` (or `codex`) rerun and the session restarted to pick up the change: it's a long-running process, not something reloaded per-request.

## Config compatibility (from beta on)

From `0.1.0-beta.1`, people's settings must survive an upgrade. That covers `~/.config/nomarmy/agents.yml`, `validators.yml` and `config.yml`, a repository's `.nomarmy.yml` and `.nomarmy.local.yml`, and the environment variables nomArmy reads. A change to any of them:

- **Never breaks silently.** Either the old file keeps working, a migration rewrites it (and says so), or nomArmy stops with an error that names the file, the key and the fix. A setting that is quietly ignored or reinterpreted counts as silent breakage.
- **Never adds a key to a file older versions validate strictly** (`config.yml`, `validators.yml`, `.nomarmy.local.yml`). Several sessions often run different nomArmy versions at once, and a session still on an older copy refuses the whole file. A draft of alpha.16 put `limits:` in `config.yml` and broke role dispatch in every open alpha.15 session. Put a new setting in a new file, or first ship a release whose loader ignores unknown keys, and only add the key in a later one. If neither is possible, the command that writes the key must say that open sessions need `nomarmy update` and a restart (as `validators add jev --endpoint` does).
- **Deprecates before it removes.** A renamed or retired key keeps working, with a warning that names its replacement, for at least one release (as `RAYSON_*` variables are translated to `NOMARMY_*`).
- **Comes with a test.** A PR that changes one of these schemas includes a test that loads a file written by the previous release and checks it still works, migrates, or fails with the documented error.

Note the change in the release notes, with what to do, under its own heading.

## Adding a harness

1. Copy `harnesses/_template/` to `harnesses/<name>/` and fill in `harness.yml` and every README section. Use a kebab-case name equal to the folder name.
2. Add a tiny fixture repo under that harness's `fixture/` folder. Document its verification commands and expected results.
3. Run `npm run docs:harnesses` to regenerate the [registry](docs/harnesses.md), then run `npm test`. CI rejects stale generated docs.

Harnesses are strict data declarations. The schema refuses unknown keys, host paths, mounts, privileged mode, capabilities, devices, environment secrets, and credential fields. These restrictions prevent a contributed harness from expanding sandbox authority. Build commands are still code and need review; the schema cannot detect secrets embedded in arbitrary command strings. Use either built-in install logic or declarative `apt` and `run`, never both. Declare services by name only with `network: services` or `network: allowlist`; omit `services` for `none`.

Image and network changes get a security review. Network declarations do not grant access: operator policy must authorize elevated verification networking when it is implemented. Workers always remain offline. Never commit credentials. The registry currently changes no image, job, or verification behavior.

## Code map

The following table shows where core functionality now lives after splitting `mcp/server.mjs` into individual modules.

| Module | What it holds |
|--------|---------------|
| `mcp/server.mjs` | MCP tool definitions, wiring of the modules below, and startup |
| `lib/server-context.mjs` | Project directory and state paths built per server |
| `lib/process.mjs` | Running processes, git helpers (run, git, gitRaw), and mapLimit |
| `lib/agent-config.mjs` | agents.yml parsing, army and model-catalog caches |
| `lib/selection.mjs` | Picking the pool entry or subscription a job runs on |
| `lib/budget-state.mjs` | Live context and budget state |
| `lib/job-budgets.mjs` | Per-job brief and report budgets |
| `lib/admission.mjs` | Admitting jobs, agent slots, and the running-job tracker |
| `lib/execute.mjs` | Running implement, scout, and decompose jobs |
| `lib/openclaw-run.mjs` | Calling OpenClaw, sandbox config, salvage, and container cleanup |
| `lib/verification-flow.mjs` | Independent verification, revert check, and union branches |
| `lib/git-record.mjs` | Git record of a job and the coordinator's commit |
| `lib/outcome.mjs` | Turning a report and evidence into an outcome, policy and refactor rules, metrics |
| `lib/outcomes.mjs` | Outcome names and coordinator statuses |
| `lib/report.mjs` | Parsing the worker's four-line report |
| `lib/worker-prompt.mjs` | The worker's brief |
| `lib/diff-checks.mjs` | Diff checks (test changes, unwired code, mislabeled tests, secrets) |
| `lib/job-format.mjs` | Formatting results for the coordinator |

## Working with local workers on this repo

This repository dogfoods itself: `nomarmy-local-worker` is configured against this same repo (see `.nomarmy.yml`, `CLAUDE.md`, `AGENTS.md`). If you're using Claude Code or Codex with nomArmy set up, the same rules apply to you as to anyone using nomArmy on their own project; see the root `CLAUDE.md`/`AGENTS.md` and `policies/` for the coordinator/worker trust boundary this project itself is built around. The short version: a worker's report is a claim, not evidence; verified Git state is the evidence.

## Code style

- No em dashes in code, comments, commit messages, or docs: use a comma, colon, semicolon, or split into two sentences.
- Default to no comments; add one only when the *why* isn't obvious from the code itself (a hidden constraint, a workaround for a specific bug, a non-obvious invariant).
- Match the existing file's style before introducing a new pattern.

## Commit messages

Explain *why*, not just *what*: the diff already shows what changed. Recent commit messages in `git log` are a good model: a short summary line, then a paragraph on the reasoning or the bug being fixed if it's not obvious from the summary alone.

## Reporting bugs or requesting features

Open a GitHub issue. For anything that looks like a security vulnerability, see [SECURITY.md](SECURITY.md) instead, and please don't open a public issue for those.

## License

By contributing, you agree your contribution is licensed under the Apache License, Version 2.0 (see [LICENSE](LICENSE)), the same license as the rest of the project.
