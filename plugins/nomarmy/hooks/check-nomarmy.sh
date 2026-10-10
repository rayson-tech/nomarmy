#!/bin/sh
# Session start (Claude Code): a plugin can register nomArmy's MCP server, but
# it can't install nomArmy. When nomarmy isn't on PATH, tell the model so it
# can tell the user what to run. Looks the command up; never runs it.
command -v nomarmy >/dev/null 2>&1 || echo "The nomArmy plugin is installed, but the nomarmy command is not on PATH, so nomArmy's tools cannot start. Tell the user to install the nomArmy CLI and run its setup by following https://nomarmy.dev/docs/install/ and then restart this session."
exit 0
