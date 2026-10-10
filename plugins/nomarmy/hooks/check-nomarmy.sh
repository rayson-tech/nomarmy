#!/bin/sh
# Session start (Claude Code): a plugin can register nomArmy's MCP server, but
# it can't install nomArmy. When nomarmy isn't on PATH, tell the model so it
# can tell the user what to run. Looks the command up; never runs it.
command -v nomarmy >/dev/null 2>&1 || echo "The nomArmy plugin is installed, but the \`nomarmy\` command isn't on PATH, so nomArmy's tools can't start. Tell the user to run \`npm install -g nomarmy\`, then \`nomarmy setup\` (it sets up the sandbox and their agents), and then restart this session. Guide: https://nomarmy.dev/docs/install/"
exit 0
