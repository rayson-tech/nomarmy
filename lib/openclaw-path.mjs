// Find OpenClaw where install.sh may have put it. With no writable npm global
// folder (common on Linux), it installs into ~/.npm-global/bin, which isn't on
// most PATHs: a fresh-install practice run ended "OpenClaw not found", and
// every job would then fail. The CLI and the MCP server call this first, so
// they and everything they spawn find it.
//
// The subscription vendor CLIs have the same problem on Windows: the front end
// starts the engine as `wsl.exe --exec <node> ...`, with no login shell, so
// ~/.profile never adds ~/.local/bin, where Claude Code's native installer puts
// `claude`. `agents add subscription claude` then said it wasn't installed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isExecutable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };

export function openclawFallbackDirs(home = os.homedir()) {
  return [path.join(home, ".npm-global", "bin"), path.join(home, ".local", "bin")];
}

/** Adds the user bin folder holding `command` to env.PATH when it isn't already reachable. Returns the folder added, or null. */
export function ensureCommandOnPath(command, env = process.env, { home = os.homedir(), platform = process.platform } = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  const dirs = String(env.PATH ?? "").split(sep).filter(Boolean);
  if (dirs.some((d) => names.some((n) => isExecutable(path.join(d, n))))) return null;
  const found = openclawFallbackDirs(home).find((d) => names.some((n) => isExecutable(path.join(d, n))));
  if (!found) return null;
  env.PATH = [found, ...dirs].join(sep);
  return found;
}

/** Adds the folder holding openclaw to env.PATH when it isn't already reachable. Returns the folder added, or null. */
export function ensureOpenClawOnPath(env = process.env, options = {}) {
  if (env.NOMARMY_OPENCLAW_CMD) return null;
  return ensureCommandOnPath("openclaw", env, options);
}

/** Same for each subscription vendor CLI (claude, codex, ...). Returns the folders added. */
export function ensureVendorClisOnPath(commands, env = process.env, options = {}) {
  return commands.map((command) => ensureCommandOnPath(command, env, options)).filter(Boolean);
}
