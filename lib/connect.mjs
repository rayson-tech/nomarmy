// Registers the nomArmy MCP server with a coordinator (Claude Code, Codex,
// or Cursor). Originally two separate bash scripts (setup-claude-worker.sh /
// setup-codex-worker.sh); ported to real JS and now the ONLY implementation
// -- install.sh calls `nomarmy connect <target>` too, not the old scripts,
// which is exactly what let a real bug (env vars silently dropped on
// reinstall) go unnoticed in the bash version for a long time: only one of
// the two implementations ever got fixed, and the fresh-install path kept
// calling the other one. Unlike install.sh itself (OS package-manager
// detection, toolchain installs, curl-piped installers, genuinely risky to
// reimplement), this registration step is small and
// purely mechanical: copy files, npm install, then either call one external
// CLI's own `mcp add` (Claude, Codex) or edit a JSON config file directly
// (Cursor, which has no CLI for this at all). Nothing here needs bash to
// exist on the host at all.
//
// The registered MCP server is always a COPY under installDir, never the
// dev checkout directly -- server.mjs resolves "../lib/verify.mjs" relative
// to its own location, so lib/ ships as installDir's sibling of mcp/.
//
// Add a new coordinator here: implement connect<Name>({ nomarmyRoot,
// installDir, run }) returning at least { installDir, serverPath }, then
// wire it into KNOWN_TARGETS and the dispatch table in bin/nomarmy.mjs.

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
  // lib/sandbox-images.mjs resolves docker/ relative to its own location
  // (lib/ and docker/ as siblings), so the installed copy needs this too,
  // not just the dev checkout -- otherwise a lazy Go/Rust image build would
  // work from a repo clone but silently fail to find its Dockerfile once
  // installed.
  const dockerSrc = path.join(nomarmyRoot, "docker");
  if (fs.existsSync(dockerSrc)) {
    fs.rmSync(path.join(installDir, "docker"), { recursive: true, force: true });
    fs.cpSync(dockerSrc, path.join(installDir, "docker"), { recursive: true });
  }
  // mcp/server.mjs resolves config/providers.yml relative to its own
  // location (mcp/ and config/ as siblings), the same lib/sandbox-images.mjs
  // pattern above uses for docker/ -- without this, an installed server can
  // never see a dispatch pool config an operator wrote into the dev
  // checkout's config/ directory. This incidentally also copies
  // common.env/profiles/*.env alongside it (the whole directory copies as
  // one unit, same as docker/), but the server never relies on reading
  // those from here: their values only ever reach it through connect-time
  // -e env injection (see deriveWorkerModelEnv below), so a stale copy of
  // either sitting in installDir is inert, never consulted.
  const configSrc = path.join(nomarmyRoot, "config");
  if (fs.existsSync(configSrc)) {
    fs.rmSync(path.join(installDir, "config"), { recursive: true, force: true });
    fs.cpSync(configSrc, path.join(installDir, "config"), { recursive: true });
  }
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

function readEnvValue(filePath, key) {
  try {
    const m = fs.readFileSync(filePath, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * config/common.env's NOMARMY_WORKER_MODEL sat unused for every model choice
 * until now -- nothing ever read it back out to actually route dispatch, so
 * picking a non-default model in `nomarmy setup`/`model` silently had no
 * effect on which model workers were routed to. This makes that file the
 * real source of truth: whatever it says the configured model and its
 * thinking support are, the MCP registration is kept in sync with, every
 * connect. Missing file or keys is not an error -- an older checkout with no
 * such keys yet just contributes nothing here, unchanged from before.
 */
export function deriveWorkerModelEnv(nomarmyRoot) {
  const commonPath = path.join(nomarmyRoot, "config", "common.env");
  const model = readEnvValue(commonPath, "NOMARMY_WORKER_MODEL");
  const thinking = readEnvValue(commonPath, "NOMARMY_MODEL_THINKING");
  const env = {};
  if (model) env.NOMARMY_WORKER_MODEL = model;
  if (thinking !== null) env.NOMARMY_WORKER_MODEL_THINKING = thinking;
  return env;
}

const SERVER_NAME = "nomarmy-local-worker";

/**
 * @param {{ nomarmyRoot: string, installDir?: string, run?: Function, extraEnv?: Record<string,string> }} input
 */
export function connectClaude({ nomarmyRoot, installDir = defaultInstallDir(), run = defaultRun, extraEnv = {} }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  const preservedEnv = captureExistingEnv(run, SERVER_NAME);
  // config/common.env is the source of truth for which model is configured;
  // its worker-routing keys always win over whatever the old registration
  // happened to have, which may be stale (a previous model swap that never
  // made it into the registration, or vice versa). Any OTHER custom env var
  // an operator set some other way is still preserved untouched.
  //
  // extraEnv exists for a narrower, different reason: a pool entry's
  // auth_env is a NAME nomArmy only ever checks for truthiness at dispatch
  // time (see lib/dispatch-config.mjs's availableEntries) -- the real
  // credential already lives in OpenClaw's own store from registration.
  // But that check runs inside the MCP SERVER's own process.env, which is
  // whatever was baked into ITS registration, not whatever happens to be
  // exported in whichever shell an operator typed `export FOO=...` into.
  // Without this, "set the env var" has no reliable path to the process
  // that actually needs to see it -- this is that path: `nomarmy providers
  // add` can request a placeholder value be baked in here directly,
  // guaranteed to reach the server regardless of shell/launch-method
  // timing. Preserved/derived keys still win on any real collision.
  const finalEnv = { ...preservedEnv, ...extraEnv, ...deriveWorkerModelEnv(nomarmyRoot) };
  quietRun(run, "claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  quietRun(run, "claude", ["mcp", "remove", SERVER_NAME]);
  const serverPath = path.join(installDir, "mcp", "server.mjs");
  // -e is variadic (`-e <env...>`): it greedily swallows every bare token
  // after it, including the server name, until the next recognized flag or
  // `--`. The server name and any --scope must come before -e, not after,
  // or `claude mcp add` rejects the server name itself as a malformed
  // "KEY=value" environment entry.
  const envArgs = Object.entries(finalEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  try {
    run("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, ...envArgs, "--", "node", serverPath]);
  } catch {
    // Compatibility fallback for Claude Code versions whose MCP command
    // does not support --scope user.
    run("claude", ["mcp", "add", SERVER_NAME, ...envArgs, "--", "node", serverPath]);
  }
  run("claude", ["mcp", "get", SERVER_NAME]);
  return { installDir, serverPath, preservedEnv: finalEnv };
}

/**
 * @param {{ nomarmyRoot: string, installDir?: string, run?: Function }} input
 */
export function connectCodex({ nomarmyRoot, installDir = defaultInstallDir(), run = defaultRun }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  quietRun(run, "codex", ["mcp", "remove", SERVER_NAME]);
  const serverPath = path.join(installDir, "mcp", "server.mjs");
  run("codex", ["mcp", "add", SERVER_NAME, "--", "node", serverPath]);
  run("codex", ["mcp", "list"]);
  return { installDir, serverPath };
}

export function defaultCursorConfigPath() {
  return process.env.NOMARMY_CURSOR_CONFIG_PATH
    || path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".cursor", "mcp.json");
}

/**
 * Cursor has no CLI for this: registration is a JSON file
 * (~/.cursor/mcp.json), read-modify-written under { mcpServers: { name: {
 * command, args, env } } }, the same schema Claude Desktop and most other
 * MCP hosts converged on. A file that does not exist yet is fine (fresh
 * install); a file that exists but fails to parse is NEVER silently
 * overwritten -- that would discard whatever else was in it (other
 * configured servers, hand edits) without the operator ever seeing it.
 */
export function readCursorConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${configPath} exists but is not valid JSON (${err.message}). Fix or remove it by hand, then re-run -- it is never overwritten blindly.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} exists but its top level is not a JSON object. Fix or remove it by hand, then re-run.`);
  }
  return parsed;
}

/**
 * @param {{ nomarmyRoot: string, installDir?: string, configPath?: string }} input
 */
export function connectCursor({ nomarmyRoot, installDir = defaultInstallDir(), configPath = defaultCursorConfigPath(), run = defaultRun }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  const serverPath = path.join(installDir, "mcp", "server.mjs");
  const config = readCursorConfig(configPath);
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  // Preserve this entry's own existing env vars (the same incident
  // connectClaude's captureExistingEnv guards against: silently dropping an
  // operator-set NOMARMY_WORKER_MODEL on every reinstall) -- every OTHER
  // configured server in the file is left completely untouched.
  const existing = config.mcpServers[SERVER_NAME];
  const preservedEnv = (existing && typeof existing.env === "object" && existing.env) || {};
  config.mcpServers[SERVER_NAME] = { command: "node", args: [serverPath], env: preservedEnv };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { installDir, serverPath, configPath, preservedEnv };
}

/** True when Cursor's config file already has a nomArmy entry -- used by
 * `nomarmy update` to decide whether to re-sync it, since Cursor has no
 * `commandExists` equivalent to check the way Claude/Codex do. */
export function cursorAlreadyConnected(configPath = defaultCursorConfigPath()) {
  try {
    const config = readCursorConfig(configPath);
    return Boolean(config.mcpServers && config.mcpServers[SERVER_NAME]);
  } catch {
    return false;
  }
}
