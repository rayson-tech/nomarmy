// Session start (Codex): a plugin can register nomArmy's MCP server, but it can't
// install nomArmy. When `nomarmy` isn't on PATH, tell the model so it can tell
// the user what to run, instead of the tools silently failing to start.
// Looks the command up rather than running it, so a session never waits on it.
import fs from "node:fs";
import path from "node:path";

const names = process.platform === "win32"
  ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => `nomarmy${ext.toLowerCase()}`)
  : ["nomarmy"];
const found = (process.env.PATH || "").split(path.delimiter).filter(Boolean).some((dir) =>
  names.some((name) => { try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; } }));

if (!found) {
  console.log("The nomArmy plugin is installed, but the nomarmy command is not on PATH, so nomArmy's tools cannot start. Tell the user to install the nomArmy CLI and run its setup by following https://nomarmy.dev/docs/install/ and then restart this session.");
}
