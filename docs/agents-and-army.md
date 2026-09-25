# Agents and the army

## Agents: where a job can run

`~/.config/nomarmy/agents.yml` (or `$NOMARMY_CONFIG_DIR`) lists every account a job can run on. An api or subscription agent is the **account**, not a model: the model is chosen per role or per job, and a `model` on the agent is only an optional default.

| Kind | What it is | Set up with |
|---|---|---|
| `local` | Your local llama-server model. `local` is built in; define another with `slot: gpt` for a second loaded model (see `config/agents.yml.example`) | nothing |
| `api` | A metered API key: `xai`, `openai`, `anthropic`, `deepinfra`, `bedrock`, `azure-openai`, `openai-compatible` (with `base_url`), or `openclaw` for any other OpenClaw provider by id | `nomarmy agents add api` |
| `subscription` | **One person's own** Claude, ChatGPT or Muse Code plan. Never pooled; every job on it names its owner. A Claude subscription's tools run on your machine, so it's for scouts and reviews unless you allow more (see [Security posture](security.md#security-posture)) | `nomarmy agents add subscription claude\|codex\|meta` |

```bash
nomarmy agents add                  # asks which kind, then walks through it
nomarmy agents list                 # each agent, and which roles use it
nomarmy agents update codex --max-concurrent 3
```

`agents add` does the whole setup and asks only when something needs you:

- **An api agent**: it registers the key with OpenClaw over stdin, typed once or read from an environment variable you name, and makes a test call. `agents.yml` only ever holds the variable's *name*.
- **A subscription**: it installs the vendor's CLI if it's missing, runs that CLI's login, installs the OpenClaw plugin the vendor needs, lists the models your plan can use, defaults the owner to the account you logged in as, and makes a real test call before saving. For Meta it also copies the key Muse Code's login stored in your macOS keychain into OpenClaw (only that auto-connected key is flat-rate, per Meta's docs), and adds Meta's provider entry to OpenClaw's config.

nomArmy starts each login; the vendor's CLI and OpenClaw do the authenticating.

```yaml
# ~/.config/nomarmy/agents.yml   (see config/agents.yml.example)
agents:
  claude: { kind: subscription, provider: claude-cli, owner: you@example.com }
  codex:  { kind: subscription, provider: openai, owner: you@example.com, max_concurrent: 3 }
  grok:   { kind: api, provider: xai, auth_env: NOMARMY_XAI_API_KEY, thinking: high }
```

**Which model runs**, first to last: the job's own `model` (the General's choice), then the role's model unless it's `auto`, then the agent's default. No model at all is refused, never guessed, and nothing picks between agents at random. A job with no role and no agent runs on `local`.

**Settings**:
- `max_concurrent`: how many jobs run on this agent at once, counted across every session on the machine. Defaults are 1 for a subscription and 2 for an api key; raising it spends your plan's usage limits faster. Api and subscription jobs together are also capped by `NOMARMY_MAX_POOL_WORKERS` (default 4), separately from local workers.
- `thinking`: `true` follows the job's level, `false` is off, or a fixed `low`, `medium` or `high`.
- `context_window`: overrides OpenClaw's catalog for a model newer than it knows.

Changes apply to the next job with no restart. The exception is a **new** api agent, which needs one `nomarmy connect claude` so the MCP server sees its key variable (`agents add` offers to do it).

**Why subscriptions are individual, never pooled.** Anthropic's terms separate "individual experimentation and automation" (sanctioned, including third-party apps through the Agent SDK, per seat and non-transferable) from "teams running shared production automation" (use the metered API). So a subscription agent belongs to one named person, a job on it must say `on_behalf_of: "<owner>"` or it's refused, and nothing ever load-balances across subscriptions. xAI subscriptions are out of scope until its terms are clear; an xAI API key is fine.

**One credential per provider id.** OpenAI, Meta and xAI keep a subscription and an API key under the same OpenClaw provider id, so `agents.yml` refuses an api agent and a subscription agent on the same one. Claude never collides: its subscription is `claude-cli`, its API key `anthropic`. A ChatGPT plan runs as `openai/<model>` through the Codex login.

**Your plan decides which models run.** A model can be listed and still refused: on a ChatGPT plan, the Codex route runs gpt-6-astra and the gpt-5.6 models but refuses gpt-6-sol and gpt-6-luna. `army assign` and `agents update --probe` test the exact route a job takes, so they catch this before a job does.

**Usage limits.** nomArmy reads how much of a subscription's limit is used where the vendor reports it: Codex in every job's session log, Claude in what Claude Code passes to the status line (Pro and Max plans). It shows in `army`, `local_worker_capacity` and the status line (`⚠ openai 85% wk`), and `nomarmy health` warns from 80%. At the limit, a job on that agent is held rather than left to fail: the General asks you, and resubmits with `confirm_over_limit: true` if you say go. Muse, Grok and API keys don't report their limits; a job that hits one in a `/feature` run pauses that agent for the run.

**Vendor terms and platform risk.** Every model call goes through [OpenClaw](https://github.com/openclaw/openclaw), and subscriptions are reached through each vendor's own CLI or login. We've read the terms that apply (see above), but using a personal subscription through a harness is exactly the kind of use vendors tighten, and a change in a vendor's terms or in OpenClaw can stop a subscription agent from working. Local models and API keys don't carry that risk. Plan on subscriptions as a convenience, not the only way your roles can run.

**Picking an agent.** Build work goes to a sandboxed agent: `local`, an api key, Codex or Muse. `local` for a bounded change against a written spec with a test; your code never leaves your machine. An api or subscription agent when the work needs more than the local model, knowing it sends code to that vendor. That's a decision about where your source travels, separate from the trust boundary, which is the same for every agent. The General itself when the answer isn't known yet.

## The army: who does what

The **General** is your coordinator session. Its charter is fixed by nomArmy: it plans and decomposes, makes architecture and security decisions, briefs and dispatches each role, reviews every result against nomArmy's verified record, owns git and integration, and gives final acceptance. It runs outside every sandbox and is never dispatched to. What you define is which agent it is:

```bash
nomarmy army general claude     # the agent for your own Claude seat
```

That lets nomArmy flag a role that runs on the General's own agent (a review that isn't independent) or on the same subscription (the same usage limit).

Every other role is yours: a name, when the General calls it, a phase, and the agent it runs on.

```bash
nomarmy army init                                             # the default roster
nomarmy army assign sr-dev codex gpt-6-astra                  # an agent and a model
nomarmy army assign pm codex auto                             # the General picks the model per job
nomarmy army assign ui-ux codex gpt-6-astra --project         # this repo, committed
nomarmy army assign security-analyst grok grok-4.7 --local    # just you, just this repo
nomarmy army show                                             # the General, the roster, and who set what
```

`army assign` makes a real test call on the job's route before it saves, and refuses a model that doesn't run.

The default roster follows a normal delivery cycle. The **Sr Dev** does the first cut and keeps the harder implementation, handing simple, well-specified work to **Jr Devs**; **UI/UX** gets UI work. Once the build is done, the specialists who apply review it (**data architect** for star schema and medallion design, **security analyst**), the **PM** reviews against the plan, and the **PO** and **stakeholders** test end to end. Not every role runs every time. Every role starts on `local`.

A job dispatches with `army_role: "security-analyst"`: nomArmy runs it on that role's agent and opens the brief with the role's description. The General reads the whole roster through the read-only `army` MCP tool.

**Config layers**, merged like Claude Code's settings (later wins, field by field):

| Layer | File | Committed | Holds |
|---|---|---|---|
| global | `~/.config/nomarmy/config.yml` | no | your default army, your General, your run limits |
| project | `<repo>/.nomarmy.yml` (`army:`, beside `verification:`) | yes | the team's roles for this repo (never the General) |
| local | `<repo>/.nomarmy.local.yml` | no; a tracked copy is refused | your overrides for this repo |

An army section can only **name agents**. It has no field for a credential, endpoint, owner or provider, so a hostile `.nomarmy.yml` in a cloned repo can at worst route a job to one of your own agents. It's also why a project file uses generic agent names (`codex`, not `jason-codex`): each teammate defines an agent by that name on their own login.

**Shared machines** (a team DGX Spark): give each person their own OS account. Subscription logins live in that account's home directory and keychain, never in a nomArmy file, so each person's coordinator only reaches their own subscriptions, and nomArmy refuses an `agents.yml` another account owns or can write. One OS account shared by several people is the pooling this design exists to prevent, and `on_behalf_of` can't detect it.
