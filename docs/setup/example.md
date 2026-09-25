# Example setup: Claude Code, Codex and an API key

A complete setup from nothing, step by step, with every command. It's the setup nomArmy itself is built with:

| Who | Runs on | Why |
|---|---|---|
| **The General** (plans, reviews, accepts) | Claude Code, on your Claude subscription | The coordinator you already talk to. Claude's tools run on your machine rather than in the sandbox, so it plans and reviews but doesn't build. |
| **Sr Dev, UI/UX, PM, PO, stakeholder** | Codex, on your ChatGPT subscription (gpt-6-astra) | Build work in the sandbox, three jobs at a time. |
| **Jr Dev** | Codex (gpt-5.6-sol) | The simple, well-specified pieces the Sr Dev hands off. |
| **Security analyst, data architect** | Grok, on an xAI API key | Reviews from a different vendor than the one that wrote the code, so the review is independent. |

No GPU and no local model: every job runs on a subscription or the API key. Your machine runs the git worktrees, the sandbox and the verification.

## Before you start

- Git, Node 20 or newer, and [Podman](https://podman.io). On macOS: `brew install podman && podman machine init && podman machine start`.
- [Claude Code](https://claude.com/claude-code), signed in to your Claude plan.
- A ChatGPT plan that includes Codex. The setup installs the Codex CLI and signs it in if it isn't already.
- An xAI API key ([console.x.ai](https://console.x.ai)). Any API provider works the same way.

## 1. Install the CLI and start the playbook

```bash
npm install -g nomarmy@alpha
cd ~/code/my-app          # the project you want nomArmy to work on
nomarmy setup
```

`nomarmy setup` shows a checklist and offers to run the next step:

```text
→ Where models run: choose where models run
  Installed: OpenClaw not found
  Agents: add a hosted agent
  Roles: add an agent first
  This repo: configure this project
  Check: verify the installation
Run `nomarmy setup --choose` now? [Y/n]
```

Say yes at each step, or run the command it names yourself. The rest of this page is those steps in order. Stop anytime: `nomarmy setup` picks up at the first step that isn't done, and `nomarmy setup --status` just prints the list.

## 2. Where models run

```bash
nomarmy setup --choose    # choose 1, hosted
```

This records that the install has no local model, so nothing tries to build llama.cpp or fall back to one. (`nomarmy setup --hosted` does the same without the question.)

## 3. Install

```bash
nomarmy install
```

This takes a few minutes. It installs [OpenClaw](https://github.com/openclaw/openclaw), which makes every model call from your machine, builds the Podman sandbox image with no network access, and registers nomArmy with Claude Code (and with Codex, if it's installed). At the end it checks the install and prints a PASS or FAIL line for each part.

## 4. Add the agents

An agent is an account a job can run on. Add three:

```bash
nomarmy agents add subscription codex
```

This installs or updates the Codex CLI and OpenClaw's Codex plugin, signs in if needed, asks whose subscription it is (your email), and makes one real test call before saving. Name it `codex`. Leave the default model blank, since each role picks its own.

```bash
nomarmy agents add subscription claude
```

The same for your Claude plan. Name it `claude`. This is the account the General runs on; nomArmy uses it to tell you when a role shares the General's usage limit.

```bash
nomarmy agents add api
```

Choose xAI, name it `grok`, accept the suggested environment variable name (`NOMARMY_XAI_API_KEY`), and paste the key when asked. The key is hidden as you type and handed to OpenClaw's credential store; nomArmy never writes it to a file.

A subscription agent runs one job at a time by default. Codex handles more; raise it:

```bash
nomarmy agents update codex --max-concurrent 3
```

Check what you have:

```bash
nomarmy agents list
```

Your `~/.config/nomarmy/agents.yml` now looks like this (no secrets in it, only names and settings):

```yaml
agents:
  codex:
    kind: subscription
    provider: openai
    owner: you@example.com
    max_concurrent: 3
    thinking: true
  claude:
    kind: subscription
    provider: claude-cli
    model: claude-opus-5-5
    owner: you@example.com
    max_concurrent: 1
    thinking: true
  grok:
    kind: api
    provider: xai
    auth_env: NOMARMY_XAI_API_KEY
    max_concurrent: 2
    thinking: true
```

## 5. Give the roles their agents

Start every role on Codex, then move the ones that belong elsewhere:

```bash
nomarmy army init --agent codex --model gpt-6-astra
nomarmy army assign jr-dev codex gpt-5.6-sol
nomarmy army assign security-analyst grok grok-4.7
nomarmy army assign data-architect grok grok-4.7
nomarmy army general claude
```

Each `assign` with a model makes one real test call on the exact route jobs take, so a model your plan refuses is caught here rather than in the middle of a job. (On a ChatGPT plan, for example, Codex runs gpt-6-astra and the gpt-5.6 models but refuses gpt-6-sol.)

See the result:

```bash
nomarmy army show
```

It lists each role with its agent and model, which config file set it, and each agent's current usage (`16% of week, resets Wed 16:32`). The roles live in `~/.config/nomarmy/config.yml`, so they apply to every project. A project can override them in its own `.nomarmy.yml`.

## 6. Set up the project

```bash
nomarmy init
```

This scans the repository and proposes a `.nomarmy.yml` with your test command as the verification profile and the policy on: nothing is committed unless verification passes, and the revert check can't be skipped. It shows the file and writes it only when you confirm. Commit it with the project.

## 7. Check

```bash
nomarmy doctor
```

Everything should pass. `nomarmy health` goes further: expiring logins, roles that can't be dispatched, usage limits, and old job data piling up.

## Use it

Restart Claude Code in the project, then try something small that has a test:

```text
Use nomArmy: the date filter on /orders ignores the end date. Fix it, with a test that fails without the fix.
```

What happens:

1. Claude Code (the General) reads the code, writes a brief with acceptance criteria, and dispatches it to the Sr Dev.
2. The job runs on Codex in its own git worktree and sandbox. The status line shows it: `🍪 sr-dev codex/gpt-6-astra 3m 2f`.
3. nomArmy checks the worker's claim: it runs your tests itself, reverts the fix to confirm the new test fails without it, and scans for secrets. Only then does it commit, on the worker's own branch.
4. Claude Code reviews the diff and tells you what's ready. Merging is yours.

For a whole feature, `/feature <what you want built>` runs build, review (the security analyst on Grok) and acceptance, and hands you a branch.

## Usage limits

The status line warns from 80% of a subscription's limit (`⚠ openai 85% wk`), and `nomarmy health` does too. A job sent to an agent that has used up its limit is held: Claude Code asks you before sending it anyway. Codex's usage refreshes after every job, and Claude's whenever Claude Code updates its status line. xAI doesn't report a limit, so an API key is only held back when a `/feature` run hits a rate-limit error.

Spreading roles across vendors, as here, also spreads the limits: builds draw on ChatGPT, reviews on the xAI key, and the General on Claude.

## Variations

- **No Claude subscription:** the General is whatever Claude Code runs on. Skip `agents add subscription claude` and `army general`; nomArmy then can't warn you when a role shares the General's limit.
- **A local model as well:** run `nomarmy setup --choose`, pick a local model, and `nomarmy install` again. Then move a role onto it, for example `nomarmy army assign jr-dev local`. No per-token bill, but it's slower and needs the memory for the model (`nomarmy sizing` tells you what fits).
- **Codex as the coordinator instead:** `nomarmy connect codex`. The army is the same; only the General changes.
