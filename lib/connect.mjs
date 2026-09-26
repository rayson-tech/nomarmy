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
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadAgents } from "./agents.mjs";
import { globalConfigDir } from "./army.mjs";
import { buildNotifierApp } from "./notifier-app.mjs";
import { recordCopySource } from "./install-freshness.mjs";

export function defaultInstallDir() {
  return process.env.NOMARMY_AGENT_INSTALL_DIR || path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".local", "share", "nomarmy-local-worker");
}

/**
 * Copy package.json/mcp/lib into installDir and `npm install` there.
 * Shared by both coordinators; has no opinion about which one is registering.
 * @param {{ nomarmyRoot: string, installDir: string, run?: Function }} input
 */
// --- The /feature playbook, installed into each coordinator ---------------
//
// One body (playbooks/*.md, with a {{REQUEST}} placeholder), rendered in
// each coordinator's own format. Every installed copy carries a
// `<!-- nomarmy:... -->` marker; a same-named file WITHOUT it is the
// operator's own and is never overwritten, only reported as skipped.
//   Claude Code  ~/.claude/commands/feature.md          -> /feature <request>
//   Codex        ~/.agents/skills/nomarmy-feature/SKILL.md (where the Codex
//                CLI, desktop app and IDE extension all look for user
//                skills; older nomArmy put it in $CODEX_HOME/skills, which
//                connectCodex cleans up)
//   Cursor       ~/.cursor/commands/feature.md (Cursor's documented
//                user-level commands directory; not verified against a
//                real install here)

const COMMAND_MARKER = "<!-- nomarmy:";
const PLAYBOOKS = Object.freeze({
  feature: {
    description: "nomArmy -- build a feature end to end with the army, then come back with a branch ready to merge",
    argumentHint: "<the feature you want> | resume <run-id>",
  },
});

export function defaultCommandDirs(env = process.env) {
  const home = os.homedir();
  return {
    claude: env.NOMARMY_CLAUDE_COMMANDS_DIR ? path.resolve(env.NOMARMY_CLAUDE_COMMANDS_DIR) : path.join(home, ".claude", "commands"),
    codex: env.NOMARMY_CODEX_SKILLS_DIR ? path.resolve(env.NOMARMY_CODEX_SKILLS_DIR) : path.join(home, ".agents", "skills"),
    cursor: env.NOMARMY_CURSOR_COMMANDS_DIR ? path.resolve(env.NOMARMY_CURSOR_COMMANDS_DIR) : path.join(home, ".cursor", "commands"),
  };
}

/** One playbook rendered for one coordinator: { relPath, text }. */
export function renderPlaybook(name, body, target) {
  const meta = PLAYBOOKS[name];
  const marker = `${COMMAND_MARKER}${name} -- installed by \`nomarmy connect ${target}\`; edits here are overwritten on the next connect -->`;
  if (target === "claude") {
    return { relPath: `${name}.md`, text: `---\ndescription: ${meta.description}\nargument-hint: ${meta.argumentHint}\n---\n${marker}\n\n${body.replace("{{REQUEST}}", "$ARGUMENTS")}` };
  }
  if (target === "codex") {
    // A skill is invoked by the model when the request matches its
    // description, so the description says when to use it.
    const description = `${meta.description}. Use when the user asks nomArmy (or "the army") to build a feature end to end, or to resume a nomArmy run by its run-id.`;
    return { relPath: path.join(`nomarmy-${name}`, "SKILL.md"), text: `---\nname: nomarmy-${name}\ndescription: ${description}\n---\n${marker}\n\n${body.replace("{{REQUEST}}", "The feature is the one the user asked for when this skill was invoked (or the run-id they asked to resume).")}` };
  }
  return { relPath: `${name}.md`, text: `${marker}\n\n# nomArmy: ${name}\n\n${body.replace("{{REQUEST}}", `The feature is the text the user wrote after /${name} (or \`resume <run-id>\`).`)}` };
}

/**
 * Install every playbook for one coordinator.
 * @returns {{ installed: string[], skipped: string[] }} relative paths
 */
export function installPlaybooks({ nomarmyRoot, target, dir = defaultCommandDirs()[target] }) {
  const srcDir = path.join(nomarmyRoot, "playbooks");
  const out = { installed: [], skipped: [], dir };
  if (!fs.existsSync(srcDir)) return out;
  for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"))) {
    const name = file.replace(/\.md$/, "");
    if (!PLAYBOOKS[name]) continue;
    const { relPath, text } = renderPlaybook(name, fs.readFileSync(path.join(srcDir, file), "utf8"), target);
    const dest = path.join(dir, relPath);
    if (fs.existsSync(dest) && !fs.readFileSync(dest, "utf8").includes(COMMAND_MARKER)) { out.skipped.push(relPath); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    out.installed.push(relPath);
  }
  return out;
}

const STATUS_LINE_REFRESH_SECONDS = 5;

/** Claude Code's user settings file. */
export function defaultClaudeSettingsPath(env = process.env) {
  return env.NOMARMY_CLAUDE_SETTINGS_PATH ? path.resolve(env.NOMARMY_CLAUDE_SETTINGS_PATH) : path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * Point Claude Code's status line at nomArmy's (lib/statusline.mjs in the
 * installed copy) -- only when no status line is configured, or when the
 * configured one is already nomArmy's (refreshed to the current path). An
 * operator's own status line is never replaced; they're told how to add
 * nomArmy's to it instead.
 * @returns {"installed"|"updated"|"kept-yours"|"unchanged"|"skipped"}
 */
export function installClaudeStatusLine({ installDir, settingsPath = defaultClaudeSettingsPath() }) {
  let settings = {};
  try { if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
  catch { return "skipped"; } // an unparseable settings file is never rewritten
  const command = `node ${JSON.stringify(path.join(installDir, "lib", "statusline.mjs"))}`;
  const current = settings.statusLine;
  if (current && !String(current.command ?? "").includes("statusline.mjs")) return "kept-yours";
  // refreshInterval: Claude Code otherwise re-runs the command only on
  // conversation events, so an idle session's elapsed times froze.
  if (current?.command === command && current?.refreshInterval === STATUS_LINE_REFRESH_SECONDS) return "unchanged";
  settings.statusLine = { type: "command", command, padding: 0, refreshInterval: STATUS_LINE_REFRESH_SECONDS };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return current ? "updated" : "installed";
}

export function installMcpCopy({ nomarmyRoot, installDir, run = defaultRun }) {
  fs.mkdirSync(path.join(installDir, "mcp"), { recursive: true });
  fs.copyFileSync(path.join(nomarmyRoot, "package.json"), path.join(installDir, "package.json"));
  fs.copyFileSync(path.join(nomarmyRoot, "mcp", "server.mjs"), path.join(installDir, "mcp", "server.mjs"));
  recordCopySource(installDir, nomarmyRoot);
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
  // lib/harnesses.mjs finds its definitions at ../harnesses/, so the copy
  // needs them too: without this, every connected session matched no
  // harness and built its jobs in the plain base image, silently.
  const harnessSrc = path.join(nomarmyRoot, "harnesses");
  if (fs.existsSync(harnessSrc)) {
    fs.rmSync(path.join(installDir, "harnesses"), { recursive: true, force: true });
    fs.cpSync(harnessSrc, path.join(installDir, "harnesses"), { recursive: true });
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
  for (const key of ["NOMARMY_EXECUTION", "NOMARMY_LLAMA_HOST", "NOMARMY_LLAMA_PORT"]) {
    const value = readEnvValue(commonPath, key);
    if (value !== null) env[key] = value;
  }
  return env;
}

const SERVER_NAME = "nomarmy-local-worker";

/**
 * Every distinct auth_env name declared across config/providers.yml's
 * pools, mapped to a placeholder value -- NEVER the real credential, which
 * lives only in OpenClaw's own store from `nomarmy agents add`'s
 * registration step.
 *
 * Why this needs to exist at all: an api agent's auth_env is checked for
 * TRUTHINESS ONLY by the dispatcher (lib/dispatch-config.mjs's
 * availableEntries), inside the MCP SERVER's own process.env -- and
 * "export it in some shell" has no reliable path to that specific process.
 * A GUI-launched coordinator never inherited a later shell export in the
 * first place; a terminal-launched one only did if the export predated
 * that specific launch. Live symptom this closes: the old providers list
 * kept showing an entry as unset even after registration had genuinely
 * succeeded and the variable really was exported -- just never in the
 * shell that mattered.
 *
 * Called on every connect, the same way deriveWorkerModelEnv already is,
 * so a newly added api agent is picked up the next time an operator
 * reconnects for ANY reason (a model swap, an update, a fresh install) --
 * not only if they remember a separate step right after `agents add`.
 * A missing/invalid agents.yml contributes nothing here, silently -- that's
 * `agents list`'s problem to report, not connect's to block on.
 */
export function derivePoolAuthEnvPlaceholders(configDir = globalConfigDir()) {
  let loaded;
  try {
    loaded = loadAgents(configDir);
  } catch {
    return {};
  }
  const env = {};
  for (const agent of Object.values(loaded.agents)) {
    if (agent.kind === "api" && agent.auth_env) env[agent.auth_env] = "registered";
  }
  return env;
}

/**
 * @param {{ nomarmyRoot: string, installDir?: string, run?: Function, extraEnv?: Record<string,string>, configDir?: string }} input
 */
export function connectClaude({ nomarmyRoot, installDir = defaultInstallDir(), run = defaultRun, extraEnv = {}, configDir = globalConfigDir(), commandsDir = defaultCommandDirs().claude, settingsPath = defaultClaudeSettingsPath() }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  const commands = installPlaybooks({ nomarmyRoot, target: "claude", dir: commandsDir });
  const notifier = buildNotifierApp({ nomarmyRoot });
  const statusLine = installClaudeStatusLine({ installDir, settingsPath });
  const preservedEnv = captureExistingEnv(run, SERVER_NAME);
  // config/common.env is the source of truth for which model is configured;
  // its worker-routing keys always win over whatever the old registration
  // happened to have, which may be stale (a previous model swap that never
  // made it into the registration, or vice versa). Any OTHER custom env var
  // an operator set some other way is still preserved untouched.
  //
  // Precedence, lowest to highest: a freshly-derived pool placeholder fills
  // in only when nothing already covers that key; whatever's genuinely
  // already registered (preservedEnv) wins over that; extraEnv is an
  // explicit, immediate ask from THIS call (e.g. `nomarmy providers add
  // --update-mcp`, right after writing a brand-new entry, before its
  // placeholder would otherwise show up here on this same call); and
  // config/common.env's derived worker-model keys still win over
  // everything, exactly as before this existed.
  const finalEnv = { ...derivePoolAuthEnvPlaceholders(configDir), ...preservedEnv, ...extraEnv, ...deriveWorkerModelEnv(nomarmyRoot) };
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
  return { installDir, serverPath, preservedEnv: finalEnv, commands, statusLine, notifier };
}

/**
 * @param {{ nomarmyRoot: string, installDir?: string, run?: Function }} input
 */
export function connectCodex({ nomarmyRoot, installDir = defaultInstallDir(), run = defaultRun, configDir = globalConfigDir(), skillsDir = defaultCommandDirs().codex, legacySkillsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills") }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  const commands = installPlaybooks({ nomarmyRoot, target: "codex", dir: skillsDir });
  removeLegacyCodexSkill(legacySkillsDir, skillsDir);
  const notifier = buildNotifierApp({ nomarmyRoot });
  // The same environment Claude's registration gets (connectClaude): the
  // install's execution mode and worker model always win, anything else an
  // operator set on the old registration is kept.
  let preservedEnv = {};
  try { preservedEnv = JSON.parse(run("codex", ["mcp", "get", SERVER_NAME, "--json"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }))?.transport?.env ?? {}; } catch { /* not registered yet */ }
  const finalEnv = { ...derivePoolAuthEnvPlaceholders(configDir), ...preservedEnv, ...deriveWorkerModelEnv(nomarmyRoot) };
  quietRun(run, "codex", ["mcp", "remove", SERVER_NAME]);
  const serverPath = path.join(installDir, "mcp", "server.mjs");
  const envArgs = Object.entries(finalEnv).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  run("codex", ["mcp", "add", SERVER_NAME, ...envArgs, "--", "node", serverPath]);
  run("codex", ["mcp", "list"]);
  return { installDir, serverPath, preservedEnv: finalEnv, commands, notifier };
}

/** Remove the skill older nomArmy installed under $CODEX_HOME/skills (only nomArmy's own copy, by its marker). */
function removeLegacyCodexSkill(legacyDir, currentDir) {
  const file = path.join(legacyDir, "nomarmy-feature", "SKILL.md");
  if (path.resolve(legacyDir) === path.resolve(currentDir)) return;
  try {
    if (fs.readFileSync(file, "utf8").includes(COMMAND_MARKER)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch { /* nothing there */ }
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
export function connectCursor({ nomarmyRoot, installDir = defaultInstallDir(), configPath = defaultCursorConfigPath(), run = defaultRun, configDir = globalConfigDir(), commandsDir = defaultCommandDirs().cursor }) {
  installMcpCopy({ nomarmyRoot, installDir, run });
  const commands = installPlaybooks({ nomarmyRoot, target: "cursor", dir: commandsDir });
  const notifier = buildNotifierApp({ nomarmyRoot });
  const serverPath = path.join(installDir, "mcp", "server.mjs");
  const config = readCursorConfig(configPath);
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  // Preserve this entry's own existing env vars (the same incident
  // connectClaude's captureExistingEnv guards against: silently dropping an
  // operator-set NOMARMY_WORKER_MODEL on every reinstall) -- every OTHER
  // configured server in the file is left completely untouched.
  // As for Claude and Codex, the install's own settings (execution mode,
  // worker model, api-key placeholders) win over whatever the entry had.
  const existing = config.mcpServers[SERVER_NAME];
  // Cursor starts a global MCP server in the home folder, not the open
  // project; ${workspaceFolder} is Cursor's own placeholder for the latter.
  const preservedEnv = { ...derivePoolAuthEnvPlaceholders(configDir), ...((existing && typeof existing.env === "object" && existing.env) || {}), ...deriveWorkerModelEnv(nomarmyRoot), NOMARMY_PROJECT_DIR: "${workspaceFolder}" };
  config.mcpServers[SERVER_NAME] = { command: "node", args: [serverPath], env: preservedEnv };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { installDir, serverPath, configPath, preservedEnv, commands, notifier };
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
