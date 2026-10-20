// Starts nomArmy's MCP server for the Claude Code plugin: runs the installed
// `nomarmy mcp`, with stdio passed straight through, so the plugin's server
// command is a script it ships rather than a bare program name. A plugin
// can't install nomArmy; when the command is missing, say what to run
// instead of failing with "command not found".
import { spawn } from "node:child_process";

const install = "nomArmy isn't installed, so its MCP server can't start. Run `npm install -g nomarmy && nomarmy setup` (https://nomarmy.dev/docs/install/), then restart this session.";

// npm installs nomarmy.cmd on Windows, which only a shell runs.
const child = spawn("nomarmy", ["mcp"], { stdio: "inherit", shell: process.platform === "win32" });
child.on("error", (error) => {
  console.error(error.code === "ENOENT" ? install : `nomArmy's MCP server couldn't start: ${error.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
