// Starts nomArmy's MCP server for the Claude Code plugin: runs the installed
// `nomarmy mcp`, with stdio passed straight through, so the plugin's server
// command is a script it ships rather than a bare program name. A plugin
// can't install nomArmy; when the command is missing, say what to run
// instead of failing with "command not found".
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const install = "nomArmy isn't installed, so its MCP server can't start. Run `npm install -g nomarmy && nomarmy setup` (https://nomarmy.dev/docs/install/), then restart this session.";

// Looked up here rather than left to the shell: on Windows a missing command
// is only cmd's own "not recognized" message, never an error to catch.
const names = process.platform === "win32"
  ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => `nomarmy${ext.toLowerCase()}`)
  : ["nomarmy"];
const found = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean)
  .flatMap((dir) => names.map((name) => path.join(dir, name)))
  .find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
if (!found) {
  console.error(install);
  process.exit(1);
}

// npm installs nomarmy.cmd on Windows, which only a shell runs; one quoted
// command line, so nothing is passed to the shell as separate arguments.
const child = /\.(cmd|bat)$/i.test(found)
  ? spawn(`"${found}" mcp`, { stdio: "inherit", shell: true })
  : spawn(found, ["mcp"], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`nomArmy's MCP server couldn't start: ${error.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
