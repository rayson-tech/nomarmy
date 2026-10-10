# nomArmy plugin

Your coding assistant plans, sandboxed workers build, and nomArmy checks every change before it counts: the tests run again in a fresh sandbox, and must fail with the change reverted. This plugin connects nomArmy to Claude Code, Codex or Cursor.

## Install nomArmy first

The plugin registers nomArmy's tools and the `feature` command. It can't install nomArmy, the sandbox or your agents, so do that first (Node 24.16+ or 26.1+, macOS, Linux or Windows):

```bash
npm install -g nomarmy
nomarmy setup
```

`nomarmy setup` walks you through Podman, OpenClaw and the agents your workers run on (a local model, api keys or your subscriptions). The [install guide](https://nomarmy.dev/docs/install/) covers each step.

## Add the plugin

**Claude Code**

```text
/plugin marketplace add rayson-tech/nomarmy
/plugin install nomarmy@nomarmy
```

**Codex**

```bash
codex plugin marketplace add rayson-tech/nomarmy
```

Then open `/plugins` in Codex, install nomArmy, and start a new session.

**Cursor**: install nomArmy from the Cursor Marketplace.

## Use it

Ask for a feature: `/nomarmy:feature add rate limiting to the upload endpoint` in Claude Code (or `/feature` when no other command has that name), the `feature` command in Cursor, or ask Codex to have nomArmy build it. Your assistant becomes the General: it plans, dispatches workers, reviews what nomArmy verified, and comes back with a branch for you to merge. nomArmy never merges for you.

Start a new session after installing. If `nomarmy` isn't on your PATH, the plugin says so at the start of each session.

## What it adds

- The `nomarmy-local-worker` MCP server, run as `nomarmy mcp`, so `nomarmy update` keeps it current.
- The `feature` skill: build a feature end to end with your army, or `resume <run-id>`.
- A session-start check that `nomarmy` is installed (Claude Code and Codex).

## What it runs and sends

- **The plugin itself** runs two things, both on your machine: `nomarmy mcp` (the nomArmy CLI you installed with npm, not code inside this plugin) and, at session start, a check that only looks for `nomarmy` on your PATH (`hooks/check-nomarmy.sh` in Claude Code, `hooks/check-nomarmy.mjs` in Codex). The plugin sends nothing anywhere and reads no credentials.
- **nomArmy, once you use it,** sends the parts of your repository a job needs to the model providers you configured in `nomarmy setup`: a local model on your machine, or the api keys and subscriptions you added (for example OpenAI, Anthropic, xAI or Bedrock). Workers run in Podman sandboxes with no network access, and every model call is made by the host-side OpenClaw process; credentials stay on your machine and are never passed to a worker. Two exceptions, both off unless you choose them: a Claude subscription runs Claude Code's own tools on your machine rather than in the sandbox (so nomArmy uses it for reviews, not builds, unless you allow it), and the optional Jev validator sends code excerpts to TypeSafe unless you point it at a server on your own machine.
- **Nothing is merged or pushed for you.** nomArmy commits verified work to worker branches in your repository; you review and merge.

[Security](https://nomarmy.dev/docs/security/) has the full trust model.

If you connected nomArmy with `nomarmy connect` before, run `nomarmy connect claude` (or `codex`) again after installing the plugin: it notices the plugin and removes its own registration, so the tools don't appear twice.

[Documentation](https://nomarmy.dev/docs/) · [Source](https://github.com/rayson-tech/nomarmy) · Apache-2.0 · Rayson Technologies
