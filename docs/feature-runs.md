# `/feature` runs, and watching jobs

## `/feature`: a feature, end to end

```
/feature add join partners to the schema context
```

The General runs the army's whole workflow on its own and comes back when it's done: a plan, the build (Sr Dev, Jr Dev, UI/UX), the reviews that apply (data architect, security analyst, then the PM against the plan) and acceptance (PO, stakeholder), sending fixes back to the builders along the way. It ends with **a branch for you to review and merge**. nomArmy never merges or pushes, and never deploys or touches cloud credentials; those are hard stops. Any other decision it would normally ask you about, it makes conservatively, records, and keeps going, and every such decision is in the final report.

`nomarmy connect` installs it: `/feature` in Claude Code, a `nomarmy-feature` skill in Codex, and `/feature` in Cursor (Cursor's path follows its documentation and hasn't been tested against a real install). A command of your own with the same name is never overwritten.

**Limits.** Each feature is a *run* (`run_start`), and its jobs join it automatically. Admission enforces the run's limits and warns at 80%:

```yaml
# ~/.config/nomarmy/config.yml (or .nomarmy.local.yml; never the committed .nomarmy.yml)
army:
  run_limits:
    max_jobs: 40        # the defaults
    max_api_usd: 10     # api agents only; a subscription isn't billed per call
    max_hours: 6
    warn_at: 0.8
```

The General can lower these for one run, never raise them. When a vendor answers with a usage-limit error, that agent is paused for the rest of the run and the General stops and tells you; it never moves the role to another vendor to get around it. The one limit no tool can see is your coordinator's own seat. If that runs out mid-feature, the run log (kept current after every phase) lets `/feature resume <run-id>` in a fresh session carry on.

**Finishing a job that came back unfinished.** A build job that ends partial, blocked or failing verification keeps its worktree, uncommitted. The General finishes it with a new job carrying `continue_from: <that job id>` and a brief of just the correction (say, the one wrong expected value in its test). The new worktree starts from the old job's base with its changes in place, and the finished whole is verified and committed together, so the foundation doesn't land outside nomArmy's checks. The commit carries a `nomArmy-Continues:` trailer naming the earlier job.

**What a run added up to.** `nomarmy stats --since 7d` (or the `stats` tool, for the General) fits on one screen: how many "done, tests pass" claims held up and how many nomArmy caught, tests shown to fail without their change, high-stakes work still needing a review, the top routing tips and spend. `--details` adds volume by role and model, code committed, time, tokens, what didn't finish, and what reviewers and review flags found. Filter with `--role`, `--model`, `--repo` and `--run <id>`. The one thing it can't count is what the General caught at integration; the report says so.

**Sharing it.** `run_finish` returns a `prBlock`, a "Verified by nomArmy" table for the pull request's description, scoped to that run; the playbook tells the General to use it as is. `nomarmy stats --share` prints the same block for any period or run, and `nomarmy stats --badge [path]` writes an SVG badge (default `.github/nomarmy-badge.svg`) plus the README line for it. Re-run it to refresh the numbers. If your README is also shown on npm, point the image at the file's raw GitHub URL, since npm doesn't resolve relative image paths (nomArmy's own README does this).

## Watching what nomArmy is doing

- **Claude Code's status line** shows what's running in this repo, a count for other repos, the open run, and the most serious health warning: `Opus 5.5 · rayson-senti │ 🍪 2: sr-dev codex 9m 10f · scout grok 1m │ run 3/14 $0.41`. `nomarmy connect claude` installs it unless you have your own; then `nomarmy statusline` prints nomArmy's part for you to add.
- **Desktop notifications** when a job finishes, a run crosses a limit or pauses an agent, or a health check finds a new problem. They come from nomArmy itself, so they work with any coordinator; on macOS they carry nomArmy's icon. `NOMARMY_NOTIFY=0` turns them off.
- **`nomarmy jobs --watch`** is a live table; **`nomarmy jobs --events`** prints one line per job start, phase change and finish, which the General watches in the background instead of polling.
- **`run_status`** lists a run's running and finished jobs, with each one's phase, last tool call and files changed so far.
- **Health checks** run a minute after each server starts and every 6 hours after that: logins about to expire, OpenClaw and plugin versions, roles that can't run, providers missing from OpenClaw's config, models refused on a real job, and storage. `nomarmy health` runs them now.

**Storage** looks after itself. OpenClaw's scratch files (about 1.2 GB for a Codex job) go when each call ends, and each health check removes finished jobs' remaining runtime data after a day (`NOMARMY_AUTO_PRUNE_HOURS`, `0` to turn it off), keeping every job's record and report. `nomarmy jobs --prune --older-than 0` does it for every finished job now.
