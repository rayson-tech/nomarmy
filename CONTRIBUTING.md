# Contributing to nomArmy

## Getting set up

```bash
git clone https://github.com/rayson-tech/nomarmy.git
cd nomarmy
npm install
npm test
```

`npm test` runs the full suite (`node --test tests/*.test.mjs`) against plain Node built-ins: no services, no network, no local model, no Podman. That's the bar for a passing PR. If your change touches something only reachable with a real local model and sandbox running (`local_worker`/`local_workers` themselves, `nomarmy setup`/`init` end to end), say so in the PR description and how you tested it manually; CI can't exercise that path.

## Before opening a PR

- Run `npm test`; it must pass.
- Keep the change scoped to what you're fixing or adding. A bug fix doesn't need surrounding cleanup.
- Add or update a test for the behavior you changed. `tests/*.test.mjs` is organized roughly one file per `lib/*.mjs` module; put a new test next to the code it covers.
- If you touched `mcp/server.mjs` and are testing against a real Claude Code or Codex session locally, remember the running MCP process needs `nomarmy connect claude` (or `codex`) rerun and the session restarted to pick up the change: it's a long-running process, not something reloaded per-request.

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
