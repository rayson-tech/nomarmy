// Registers the nomArmy MCP server with a coordinator (Claude Code or
// Codex). Ported from scripts/setup-claude-worker.sh / setup-codex-worker.sh
// into real JS rather than left as bash scripts nomarmy update/connect would
// otherwise have to shell out to -- unlike install.sh (OS package-manager
// detection, toolchain installs, curl-piped installers, genuinely risky to
// reimplement), these two scripts are small and purely mechanical: copy
// files, npm install, call one external CLI's own `mcp add`. Nothing here
// needs bash to exist on the host at all.
//
// The registered MCP server is always a COPY under installDir, never the
// dev checkout directly -- server.mjs resolves "../lib/verify.mjs" relative
// to its own location, so lib/ ships as installDir's sibling of mcp/.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function defaultInstallDir() {
  return process.env.NOMARMY_AGENT_INSTALL_DIR || path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".local", "share", "nomarmy-local-worker");
}

/**
 * Copy package.json/mcp/lib into installDir and `npm install` there.
 * Shared by both coordinators; has no opinion about which one is registering.
 * @param {{ nomarmyRoot: string, installDir: string, run?: Function }} input
 */
export function installMcpCopy({ nomarmyRoot, installDir, run = defaultRun }) {
  fs.mkdirSync(path.join(installDir, "mcp"), { recursive: true });
  fs.copyFileSync(path.join(nomarmyRoot, "package.json"), path.join(installDir, "package.json"));
  fs.copyFileSync(path.join(nomarmyRoot, "mcp", "server.mjs"), path.join(installDir, "mcp", "server.mjs"));
  fs.rmSync(path.join(installDir, "lib"), { recursive: true, force: true });
  fs.cpSync(path.join(nomarmyRoot, "lib"), path.join(installDir, "lib"), { recursive: true });
  run("npm", ["install", "--omit=dev"], { cwd: installDir });
  run(process.execPath, ["--check", "mcp/server.mjs"], { cwd: installDir });
}

function defaultRun(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}
// Best-effort removal of an old registration: failure (nothing registered
// under that name yet, likely a fresh install) is expected, not an error.
// Takes the same injected `run` every other call in this module does, so a
// test's fake `run` sees every subprocess this module would spawn, never
// only some of them.
function quietRun(run, cmd, args, opts = {}) {
  try { return run(cmd, args, opts); } catch { return null; }
}

/**
 * Pull the "KEY=value" lines out of `claude mcp get <name>`'s "Environment:"
 * section. Observed live: a registration carrying NOMARMY_WORKER_MODEL (an
 * operator testing a non-default local model) silently lost that variable
 * on the next `nomarmy connect`/`update`, because the re-add below used to
 * pass no -e flags at all -- reinstalling the server code reset which model
 * every dispatch actually used, with no warning. A blank line or a line that
 * is not "KEY=value" ends the block; nothing registered yet is not an error.
 */
export function parseClaudeEnv(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*Environment:\s*$/.test(l));
  if (start === -1) return {};
  const env = {};
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return env;
}

function captureExistingEnv(run, name) {
  try {
    const out = run("claude", ["mcp", "get", name], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    return parseClaudeEnv(out);
  } catch {
    return {};
  }
}

const SERVER_NAME = "nomarmy-local-worker";

/**
 * @param {{ nomarmyRoot: string, installDir?: string, run?: Function }} input
 */
export function connectClaude({ nomarmyRoot, installDir = defaultInstallDir(), run = defaultRun }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  const preservedEnv = captureExistingEnv(run, SERVER_NAME);
  quietRun(run, "claude", ["mcp", "remove", "rayson-local-worker", "--scope", "user"]);
  quietRun(run, "claude", ["mcp", "remove", "rayson-local-worker"]);
  quietRun(run, "claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  quietRun(run, "claude", ["mcp", "remove", SERVER_NAME]);
  const serverPath = path.join(installDir, "mcp", "server.mjs");
  // -e is variadic (`-e <env...>`): it greedily swallows every bare token
  // after it, including the server name, until the next recognized flag or
  // `--`. The server name and any --scope must come before -e, not after,
  // or `claude mcp add` rejects the server name itself as a malformed
  // "KEY=value" environment entry.
  const envArgs = Object.entries(preservedEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  try {
    run("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, ...envArgs, "--", "node", serverPath]);
  } catch {
    // Compatibility fallback for Claude Code versions whose MCP command
    // does not support --scope user.
    run("claude", ["mcp", "add", SERVER_NAME, ...envArgs, "--", "node", serverPath]);
  }
  run("claude", ["mcp", "get", SERVER_NAME]);
  return { installDir, serverPath, preservedEnv };
}

/**
 * @param {{ nomarmyRoot: string, installDir?: string, run?: Function }} input
 */
export function connectCodex({ nomarmyRoot, installDir = defaultInstallDir(), run = defaultRun }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  quietRun(run, "codex", ["mcp", "remove", "rayson-local-worker"]);
  quietRun(run, "codex", ["mcp", "remove", SERVER_NAME]);
  const serverPath = path.join(installDir, "mcp", "server.mjs");
  run("codex", ["mcp", "add", SERVER_NAME, "--", "node", serverPath]);
  run("codex", ["mcp", "list"]);
  return { installDir, serverPath };
}
