# FAQ

## Models and usage

### Which model should my roles use?

Split by how hard the work is, not by one favorite model. On a ChatGPT plan, for example:

```bash
nomarmy army assign sr-dev codex gpt-6-astra    # the core and the harder implementation
nomarmy army assign jr-dev codex gpt-5.6-sol    # simple, fully specified pieces
nomarmy army assign pm codex auto               # the General picks per job
```

A frontier model like gpt-6-astra is worth it for subtle work and review; a lighter one like gpt-5.6-sol handles well-specified coding for a fraction of the usage. With a role on `auto`, the General picks per job, and `/feature` tells it to use the lighter model for routine work and the frontier one for subtle work. `nomarmy stats --model gpt-6-astra` shows what each model has actually been doing.

### Can I switch a running job to a cheaper model?

Not in place: a job's model is fixed when it's dispatched. But you can stop it and finish the work on another model. Ask the General to stop it (the `local_worker_stop` tool), or run `nomarmy jobs --stop <job id>` yourself: the worker ends within about 15 seconds, without a report-recovery call or a verification run, and its worktree is kept. Then a new job with `continue_from: <job id>` and `model: gpt-5.6-sol` picks the work up where it stopped.

Messaging the General mid-job is safe either way: nothing about the running job changes unless it's stopped, and the General applies what you say to the jobs it sends next. To move work to a cheaper model from now on:

- **For every job on a role:** `nomarmy army assign sr-dev codex gpt-5.6-sol`. It applies to the next job, with no restart.
- **For one job:** ask the General to send it with `model: gpt-5.6-sol`. A job's `model` overrides the role's.
- **To finish a job on a cheaper model:** if it comes back partial, failing verification or stopped, the General can continue it with `continue_from: <job id>` and `model: gpt-5.6-sol`. The new job starts from the old one's unfinished work, so nothing is redone.

### Does nomArmy switch models when I'm near my usage limit?

No, the General does. nomArmy reads how much of a subscription's limit is used (Codex from every job's own session log, Claude from what Claude Code reports), shows it in `army`, `local_worker_capacity` and the status line, warns from 80%, and holds new jobs on that agent at the limit until you say go. Which model to use with the headroom left is the General's call, or yours with `army assign`. A reading is only as fresh as the last job on that agent: after you reset your usage, the next job's reading shows it.

### Why is my usage going so fast?

A worker re-reads its whole conversation on every step, so most of a job's tokens are cached context, and a frontier model spends its allowance fastest. Put the routine roles on a lighter model (above), keep briefs focused on one outcome, and prefer `mode: verify` (no model at all) for checks that only run existing tests. `nomarmy stats` shows tokens by model.
