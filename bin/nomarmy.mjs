#!/usr/bin/env node
// nomArmy CLI. Every command proposes before it writes anything -- init,
// setup, model and update all show exactly what would change and write only
// after explicit confirmation ([y/N]) or an explicit non-interactive flag
// (--write, --json with the required choices given up front). System-level
// setup (install.sh: OpenClaw, the sandbox, llama.cpp for a local model)
// runs only when asked: `nomarmy install`, or `nomarmy setup` after it has
// shown the exact command and the operator said yes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execHostGitSync, spawnHostGitSync } from "../lib/worktree-pointer.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, validateConfig, stringifyConfig, findConfigFile, parseYaml, CONFIG_FILENAMES } from "../lib/config.mjs";
import { scanRepository, compareEvidence } from "../lib/scan.mjs";
import { buildConfigProposal } from "../lib/propose.mjs";
import { detectHardware } from "../lib/hardware.mjs";
import { readGGUFMetadata, resolveModelPath, totalSplitBytes } from "../lib/gguf.mjs";
import { recommend, customRecommendation, evaluateConfig, bytesPerKvElementForCacheTypes, MIN_CONTEXT_PER_NOM } from "../lib/sizing.mjs";
import { windowsFrontEnd, dropWindowsPath, markWindowsCoordinator, pickDistro, resolveWslNomarmy, mcpBridgeLaunch, writeWindowsSettings } from "../lib/wsl.mjs";
import { windowsPlan, windowsForward, windowsSetup, windowsDoctor } from "../lib/wsl-cli.mjs";
import { connectViaWsl, connectClaude, connectCodex, connectCursor, cursorAlreadyConnected, deriveWorkerModelEnv, defaultInstallDir, installMcpCopy, SCOPES, claudeUserScoped, portableServerLaunch } from "../lib/connect.mjs";
import { compareVersions, readPackageVersion, readInstallVersions, copyIsStale } from "../lib/install-freshness.mjs";
import { loadJobRecords, computeStats, formatStats, formatStatsSummary, parseSince, resolveRepo, agentLookup } from "../lib/stats.mjs";
import { requestJobStop } from "../lib/openclaw-run.mjs";
import { loadValidators, saveJevKey, removeJev, jevSettings, askJev, validatorsPath, JEV_CHECKS, saveJudge, removeJudge, judgeSettings, judgeAgentChoices, chooseJudgeAgent, confirmJudgeHostTools } from "../lib/validators.mjs";
import { probeModel } from "../lib/model-probe.mjs";
import { ID_RE, AUTH_ENV_NAME_RE, OPENCLAW_PROVIDER_ID_RE, openclawProviderId, isNativeProviderType } from "../lib/dispatch-schema.mjs";
import { loadAgents, readAgentsFile, writeAgentsFile, agentsConfigPath, apiAgentAsPoolEntry, describeAgent as describeAgentLabel, agentRunsToolsOnHost, agentProviderId, AGENT_KINDS, API_PROVIDER_TYPES, RESERVED_AGENT_NAMES, BUILTIN_LOCAL_AGENT } from "../lib/agents.mjs";
import { loadArmy, mergeArmy, describeArmy, readArmyFile, updateArmyInFile, assignRoleInFile, parseTargetSpec, armyLayerPath, globalConfigDir, DEFAULT_ARMY, ARMY_PHASES, LOCAL_CONFIG_FILENAME } from "../lib/army.mjs";
import { parseLlamaUrl } from "../lib/execution.mjs";
import { setupSteps, formatSetupSteps, runSetupPlaybook } from "../lib/setup-steps.mjs";
import { readUsageSnapshots, refreshStaleOverLimitReadings } from "../lib/usage-limits.mjs";
import { pickMachine, planResize } from "../lib/sandbox-vm.mjs";
import { listProcesses, staleSessions, formatStaleSessions } from "../lib/stale-sessions.mjs";
import { readSetting, writeSetting, writeEnvLine, userCommonPath, userProfilePath, profilePathFor, tildePath } from "../lib/user-config.mjs";
import { MIN_PODMAN_VM_MB } from "../lib/doctor.mjs";
import { liveLeases } from "../lib/slots.mjs";
import { ensureProviderConfig } from "../lib/openclaw-config.mjs";
import { linkCodex } from "../lib/codex-link.mjs";
import { recordProbeSuccess, parseOpenclawAuthProfiles, codexImportRecovery } from "../lib/health.mjs";
import { pruneJobRuntime } from "../lib/prune.mjs";
import { SUBSCRIPTION_VENDORS, parseOpenclawVersion, versionAtLeast, parseCatalogModels, parseCliLoginStatus, probeOutcome, openclawSignInFailure, parseMuseAuthDescriptor, extractMintedKey } from "../lib/subscription-setup.mjs";
import { PINNED_OPENCLAW_VERSION, repairOpenclaw, verifyOpenclaw, configuredSubscriptionVendors } from "../lib/openclaw-install.mjs";
import { ensureOpenClawOnPath } from "../lib/openclaw-path.mjs";
import { THINKING_LEVELS } from "../lib/thinking.mjs";
import { fileURLToPath } from "node:url";
// Inside WSL, only the distro's own tools (see lib/wsl.mjs).
dropWindowsPath();
// The Windows front end: whatever it forwards knows the coordinators are on Windows.
if (windowsFrontEnd()) markWindowsCoordinator();
// OpenClaw in ~/.npm-global/bin (no writable npm prefix) is found without the operator editing PATH.
ensureOpenClawOnPath();
// Windows starts the engine as `wsl.exe --exec <node> nomarmy.mjs`, with no
// login shell, so an nvm Node's directory isn't on PATH. Children that need
// `node` (install.sh, OpenClaw's `#!/usr/bin/env node`) get the one running.
{
  const nodeDir = path.dirname(process.execPath);
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  if (!entries.includes(nodeDir)) process.env.PATH = [nodeDir, ...entries.filter(Boolean)].join(path.delimiter);
}

// Add a new coordinator: add its name here, teach commandExists/connectTarget
// about it below (a JSON-file target like Cursor has no PATH binary to check
// and should short-circuit commandExists to true), and give cmdUpdate its own
// "already connected, so resync" detection if it has no CLI to probe.
const KNOWN_TARGETS = ["claude", "codex", "cursor"];

function connectTarget(target, { nomarmyRoot, run, scope = "user", projectDir = null }) {
  if (target === "claude") return connectClaude({ nomarmyRoot, run, scope, projectDir });
  if (target === "codex") return connectCodex({ nomarmyRoot, run, scope });
  if (target === "cursor") return connectCursor({ nomarmyRoot, run, scope, projectDir });
  throw new Error(`unknown connect target: ${target}`);
}

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const repoDir = path.resolve(value("repo", process.cwd()));
// --json shape for `agents add`/`agents update`'s thinking field:
// `--thinking low|medium|high` sets that entry's own fixed reasoning floor
// (see thinkingSchema's doc comment); a bare `--thinking` (no value, or a
// value that isn't a real level) keeps the original boolean meaning (pass
// through the job's requested reasoning); `--no-thinking` is always false.
// Returns undefined when none of these flags were passed at all, so the
// caller can tell "not touched" apart from "explicitly set".
// Every level OpenClaw accepts (lib/thinking.mjs).
function resolveThinkingFlag() {
  const level = value("thinking");
  if (level && THINKING_LEVELS.includes(level)) return level;
  if (flag("no-thinking")) return false;
  if (flag("thinking")) return true;
  return undefined;
}
const json = flag("json");
const out = (obj) => console.log(JSON.stringify(obj, null, 2));
const gib = (n) => (typeof n === "number" ? `${(n / 1024 ** 3).toFixed(1)} GiB` : "unknown");
const K = (n) => (typeof n === "number" ? `${Math.round(n / 1024)}K` : "?");

// A plain wall of text doesn't match this project's own tone (a mascot, a
// tagline). Used only by the newer interactive commands (init/setup/model);
// the rest of the CLI's output is untouched, on purpose, to keep this change
// scoped. Off under --json and when stdout isn't a real terminal (piped,
// redirected) so color codes never leak into something meant to be parsed.
const useColor = process.stdout.isTTY && !json;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };

function usage(code = 0) {
  console.log(`nomArmy - bounded coding workers with independently verified results

Usage: nomarmy <command> [options]

  scan            Inspect this repository and report its execution environment.
                  --check   compare the evidence against a committed .nomarmy.yml
  init            Propose a .nomarmy.yml from this repository's scan evidence
                  and write it after confirmation.
                  --force   overwrite an existing .nomarmy.yml
                  --write   with --json, write without prompting (needs a valid proposal)
  setup           Show setup progress and run the next unfinished step.
                  --status [--json]      print the checklist only
                  --choose               choose hosted/local/remote/Bedrock
                  --hosted               skip hardware/model questions
                  --llama-url <url>       use a shared llama-server
                  --json --profile-name <name> [--model <model>] [--tier <more|nominal>]
                                         write a profile non-interactively
  install         Run the bundled installer for the chosen setup profile.
                  --profile <name>       override NOMARMY_SETUP_PROFILE
                  --no-claude            skip Claude Code registration
  model           Change the configured model later, without the rest of
                  setup's questions. Offers to also resync the MCP
                  registration's worker-routing env vars, and to restart
                  local inference so the running llama-server actually
                  loads the new model (writing the config alone leaves
                  the running process serving whatever it loaded at its
                  own last start).
                  --update-mcp        with --json, also resync the MCP
                                      registration (never done silently)
                  --restart-inference with --json, also stop/start local
                                      inference (never done silently)
  update          Update nomArmy and reconnect your coordinators: installs
                  npm's latest alpha, or for a git checkout pulls (fast-forward
                  only; refuses on local changes). Then restart open sessions.
  agents <list|add|update|remove>
                  Every account a job can run on, in one list:
                  ~/.config/nomarmy/agents.yml (or NOMARMY_CONFIG_DIR).
                    local         the local model (built in as \`local\`)
                    api           a metered API key: xai, openai,
                                  anthropic, deepinfra, bedrock, azure,
                                  any OpenClaw provider by id ("openclaw",
                                  e.g. DeepSeek), or an OpenAI-compatible URL
                    subscription  ONE person's own Claude, ChatGPT or Muse
                                  Code plan; never pooled, and every job
                                  must name its owner in on_behalf_of
                  Changes apply to the next job, no restart.
                  list      show your agents
                  An api or subscription agent is an account; its
                  model is only an optional default, since each role
                  (or the General, per job) picks the model.
                  add [local|api|subscription] [claude|codex|meta]
                            walks through what that kind needs: an API
                            key registered with OpenClaw (over stdin,
                            never saved to a file), or the vendor's own
                            CLI install and login, OpenClaw's plugin and
                            login, and for Meta the key Muse Code's login
                            left in the macOS keychain. Then a real test
                            call before saving. Interactive, or --json
                            --name <n> --kind <kind> plus that kind's
                            fields: --slot coder|gpt (local); --provider
                            --model --auth-env [--base-url]
                            [--openclaw-provider --plugin] [--register]
                            [--update-mcp] (api); --provider --model
                            --owner (subscription). Codex JSON setup can
                            --link-openclaw after CLI login; removing a
                            capturing email profile non-interactively needs
                            --remove-email-profiles. Interactive Codex setup
                            asks before copying the CLI login (default yes),
                            and offers email-profile removal separately.
                            For any kind, optionally
                            --max-concurrent --context-window
                            --thinking [minimal|low|medium|high|xhigh|adaptive|max|ultra] --no-thinking
                  update <name>
                            change the model (picked from what OpenClaw
                            lists; a subscription gets a real test call),
                            slot, auth_env, base_url, max_concurrent,
                            context_window or thinking. Kind, provider and
                            owner stay fixed: that's a different agent.
                            --no-model clears the default model, so every
                            role or job names its own.
                            (--json with the matching flags; --probe to
                            test-call the agent; without a name, all agents)
                  remove <name>
                            remove one agent
  army <show|init|assign|general>
                  Who does what. The General is your coordinator session:
                  its charter is fixed by nomArmy, and you define which
                  agent it is. Each other role has a description, a phase
                  (build, review, acceptance) and one agent. Layers merge
                  like Claude Code's settings, later wins: global
                  ~/.config/nomarmy/config.yml, the repo's .nomarmy.yml,
                  then its gitignored .nomarmy.local.yml. Army sections
                  only pick agents by name; they can never hold a
                  credential or endpoint. Jobs dispatch with
                  \`army_role\`; edits apply to the next job, no restart.
                  show      the General, the roster, which layer set what,
                            and roles that share the General's model or
                            usage (--json is what the \`army\` tool returns)
                  init      write the default roster (Sr Dev, Jr Dev,
                            UI/UX, data architect, security analyst, PM,
                            PO, stakeholder, all on \`local\`) to --global
                            (default), --project or --local; --force
                            replaces an existing one; --agent <name>
                            starts every role there, optionally with
                            --model <model|auto>
                  assign <role> <agent|none> [model|auto]
                            give a role an agent, and optionally the model
                            to run on it ("auto" lets the General pick per
                            job; omitted, the agent's default), in --global
                            (default), --project or --local. A named model
                            gets one real test call first (a listed model
                            isn't proof it runs); --no-check skips that
                  general <agent>
                            which agent the General is, in --global
                            (default) or --local
  config paths    where agents.yml and the three army layers live
  config max-jobs [n]
                  how many api and subscription jobs run at once, across
                  every session (default 4); with n, sets it in limits.yml.
                  Warns when the Podman VM is too small for that many.
  jobs [--watch|--events [--until-done] [--run <run-id>] [--repo <path>]|--prune|--wait <jobId> [<jobId> ...]|--stop <jobId> [--reason <text>]] [--interval N] [--older-than DAYS]
                  what's running across every session (agent, model, phase,
                  last tool call, files changed, heartbeat) and what just
                  finished; --watch redraws every N seconds (default 3);
                  --events prints one line per start, phase change and
                  finish (--json for JSON lines). It's a stream: read it
                  with a monitor that wakes on each line. A background
                  command is only reported when it exits, so there use
                  --events --until-done --run <run-id> for a whole run,
                  or --wait <id> <id> ... for specific jobs. Unscoped
                  --until-done watches every job on this machine. The plain
                  stream ends on its own after 30 minutes with nothing
                  running (--idle-minutes N); --prune removes the bulky runtime data
                  from finished jobs older than DAYS (default 2), keeping
                  their records, reports and any retained worktree;
                  --wait <jobId> [<jobId> ...] [--timeout <seconds>]
                  blocks until all finish; comma-separated ids also work
                  (default timeout 1800; --json is supported);
                  --events --repo <path> limits events to one repository;
                  --stop <jobId> stops a running job's worker (no report
                  recovery, no verification), keeping its worktree for
                  continue_from
  health          check what's likely to break a run before it does:
                  expiring logins, an outdated OpenClaw or plugin, roles
                  that can't be dispatched, an unloadable agents.yml,
                  piled-up job storage. The MCP server also runs this
                  every 6 hours and notifies once per new warning
  statusline      the one-line summary Claude Code's status line shows
                  (installed by \`nomarmy connect claude\` when no status
                  line is set); reads the session JSON on stdin
  connect [claude] [codex] [cursor] [--scope user|local|project]
                  (Re-)register the MCP server with one or more coordinators.
                  With no target and not --json, prompts an interactive
                  multi-select instead. --scope user (default) registers it
                  for every project; local for this repository, only you;
                  project for this repository, committed for the team
                  (.mcp.json or .cursor/mcp.json, running \`nomarmy mcp\`).
                  Codex has only the user scope.
  stats [--since 7d|<date>] [--until <date>] [--role <role>] [--model <model>] [--run <id>] [--details] [--all-suggestions] [--share] [--badge [path]]
        [--repo <path|name>] [--all-repos] [--json]
                  What nomArmy's job records show for this repository (or
                  all): volume by role and model, code committed, time,
                  tokens and spend, how often a "done" report failed
                  independent verification, what didn't finish, reviewers,
                  and review flags. From verified records, never reports.
  validators <list|add jev|test jev|remove jev|add judge|test judge|remove judge>
                  Optional semantic checks from a model you configure with
                  your own key. Jev checks focused claims with TypeSafe;
                  Judge reviews diffs with one of your configured agents.
                  Setup asks for any consent it needs. \`add jev\` asks for the
                  key without echoing it (or reads --key-stdin), saves it
                  where only you can read it, and makes one test call. Its
                  answers only add review flags, and it sends excerpts of
                  your code to TypeSafe. \`add judge --agent <name> --model
                  <model>\` makes one of your agents a model judge: does the
                  diff meet each acceptance criterion, match the report, keep
                  its tests as strong? An agent whose tools run on this
                  machine needs --host-tools.
  mcp             Start nomArmy's MCP server on stdio with this machine's
                  settings. What a --scope project registration runs.
  sandbox         The Podman VM every sandbox shares (macOS, Windows): its
                  memory, disk and images. --memory <GiB> resizes it (stops,
                  sets, restarts; refused while jobs run); --prune removes
                  images no container uses (nomArmy rebuilds its own on
                  demand); --repair restores missing subordinate ID
                  ranges (refused while jobs run); --yes skips confirming
  start <profile> Start local inference (wraps scripts/start-inference.sh).
  stop <profile>  Stop local inference (wraps scripts/stop-inference.sh).
  uninstall       Remove the MCP registration and install directory.
                  --clear-agents  also remove job records, logs and the
                                  built llama.cpp binary (rebuilt on next
                                  install)
                  --clear-models  also remove the model repo config/
                                  common.env references from the local
                                  Hugging Face cache
                  --all           both of the above
                  --force         skip the confirmation prompt for either
                                  (required alongside --json)
  validate        Validate .nomarmy.yml against the schema.
  sizing          Recommend context and nom count for this machine.
                  --check     evaluate the loaded profile instead of recommending
                  --noms <N>  size for exactly N workers instead of the max
                              that fits ("more noms") or the fixed
                              shipped-profile default ("nominal"); also
                              offered as an interactive prompt at the end
                              of the plain (non --json) report
  doctor          Check this host is ready to run nomArmy, with a fix for
                  anything missing.
  help

Options:
  --repo <dir>    repository to inspect (default: cwd)
  --json          machine-readable output; disables interactive prompts
  --model <path>  GGUF file to size against (default: auto-discover)
  --execution <m> local | bedrock (default: $NOMARMY_EXECUTION or local)
`);
  process.exit(code);
}

// Model discovery and split-shard size summing live in lib/gguf.mjs, tested
// there; this is a thin wrapper binding the CLI's own --model flag.
function findModel() {
  return resolveModelPath({ explicit: value("model"), env: process.env });
}

function printWarnings(warnings = []) {
  if (!warnings.length) return;
  console.log("");
  for (const w of warnings) console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
}

function cmdScan() {
  const evidence = scanRepository(repoDir);
  if (flag("check")) return scanCheck(evidence);
  if (json) return out(evidence);

  console.log(`Repository evidence for ${evidence.repoName}\n`);
  for (const [name, count] of Object.entries(evidence.counts)) {
    if (count > 0) {
      console.log(`  ${String(name).padEnd(14)} ${count}${evidence[name]?.truncated ? " (truncated)" : ""}`);
    }
  }
  const services = evidence.services?.items ?? [];
  if (services.length) {
    console.log("\nServices:");
    for (const s of services) {
      console.log(`  ${s.name}${s.image ? `  ${s.image}` : ""}${s.source ? `   (${s.source})` : ""}`);
    }
  }
  const notes = evidence.notes?.items ?? [];
  if (notes.length) {
    console.log("\nNotes:");
    for (const n of notes) console.log(`  ${typeof n === "string" ? n : n.message ?? JSON.stringify(n)}`);
  }
  console.log("\nThis is deterministic evidence only - nothing here was executed.");
  console.log("Describe the environment in .nomarmy.yml, then run 'nomarmy validate'.");
}

function scanCheck(evidence) {
  let loaded;
  try {
    loaded = loadConfig(repoDir);
  } catch (err) {
    if (json) return out({ error: err.message, errors: err.errors ?? [] });
    console.error(`Cannot compare: ${err.message}`);
    process.exit(1);
  }
  const drift = compareEvidence(evidence, loaded.found ? loaded.config : null);
  if (json) return out({ evidence, drift });
  if (!loaded.found) {
    console.log(`No ${CONFIG_FILENAMES.join(" or ")} found in ${evidence.repoName}.`);
    console.log("Run 'nomarmy scan' to see what this repository appears to need.");
    process.exit(1);
  }
  console.log(`Comparing ${path.basename(loaded.path)} against repository evidence\n`);
  if (drift.summary) console.log(`Drift: ${drift.summary.missingFromConfig} missing from config, ${drift.summary.missingFromRepo} missing from repo (${drift.summary.total} total)\n`);
  for (const section of ["services", "ports", "environment", "commandKinds"]) {
    const d = drift[section];
    if (!d) continue;
    for (const m of d.missingFromConfig ?? []) console.log(`  repo has, config omits:  ${section}: ${typeof m === "object" ? JSON.stringify(m) : m}`);
    for (const m of d.missingFromRepo ?? []) console.log(`  config has, repo lacks:  ${section}: ${typeof m === "object" ? JSON.stringify(m) : m}`);
  }
  process.exit(drift.ok ? 0 : 1);
}

function cmdValidate() {
  let loaded;
  try {
    loaded = loadConfig(repoDir);
  } catch (err) {
    if (json) return out({ valid: false, errors: err.errors ?? [err.message], path: err.path ?? null });
    console.error(`Invalid ${err.path ? path.basename(err.path) : "config"}:`);
    for (const e of err.errors ?? [err.message]) console.error(`  ${e}`);
    process.exit(1);
  }
  if (!loaded.found) {
    if (json) return out({ found: false });
    console.log(`No ${CONFIG_FILENAMES.join(" or ")} in ${repoDir}. Nothing to validate.`);
    return;
  }
  const res = validateConfig(loaded.config);
  if (json) {
    return out({ found: true, path: loaded.path, valid: res.valid, errors: res.errors, elevated: loaded.elevated });
  }
  console.log(`${path.basename(loaded.path)} is valid.`);
  const { shared = [], remote = [] } = loaded.elevated ?? {};
  if (shared.length || remote.length) {
    console.log("\nElevated services requiring explicit policy approval:");
    for (const s of shared) console.log(`  shared:  ${s}   (mutable state shared across jobs)`);
    for (const r of remote) console.log(`  remote:  ${r}   (traffic leaves this machine)`);
    console.log("\nThese are accepted by the schema but are not enabled by default.");
  }
}

/**
 * `nomarmy init`: scan the repository, propose a `.nomarmy.yml` from the
 * evidence, and write it only after explicit confirmation (interactive) or
 * an explicit `--write` flag (non-interactive, `--json`). Never overwrites an
 * existing file without `--force` -- a human-authored config is never
 * silently clobbered by a guess.
 */
async function cmdInit() {
  const existing = findConfigFile(repoDir);
  if (existing && !flag("force")) {
    if (json) { out({ error: `${path.basename(existing)} already exists`, path: existing }); process.exit(1); }
    console.log(c.yellow(`${path.basename(existing)} already exists at ${existing}.`));
    console.log("Not overwriting a config someone already wrote. Re-run with --force to replace it.");
    process.exit(1);
  }

  const evidence = scanRepository(repoDir);
  const { proposal, valid, errors, excludedFixturePaths, notes } = buildConfigProposal(evidence);
  // --force regenerates what the scan can see; the army section is a human
  // decision the scan knows nothing about, so it carries over untouched.
  if (existing) {
    try {
      const previousArmy = parseYaml(fs.readFileSync(existing, "utf8"), existing)?.army;
      if (previousArmy) proposal.army = previousArmy;
    } catch { /* an unparseable old file has nothing safe to carry over */ }
  }
  const targetPath = path.join(repoDir, existing ? path.basename(existing) : CONFIG_FILENAMES[0]);

  if (json) {
    if (!flag("write")) return out({ proposal, valid, errors, excludedFixturePaths, notes, wouldWriteTo: targetPath });
    if (!valid) { out({ error: "proposal does not validate; refusing to write", errors }); process.exit(1); }
    fs.writeFileSync(targetPath, stringifyConfig(proposal));
    return out({ written: targetPath, proposal });
  }

  console.log(c.bold(`🍪 Proposed ${path.basename(targetPath)}`) + c.dim(`, built from ${evidence.repoName}'s scan evidence:`) + "\n");
  console.log(stringifyConfig(proposal));
  if (excludedFixturePaths.length) {
    console.log(c.yellow("Excluded as likely test fixtures (review by hand if any of these is real):"));
    for (const p of excludedFixturePaths) console.log(c.dim(`  ${p}`));
    console.log("");
  }
  if (notes.length) { for (const n of notes) console.log(c.dim(`Note: ${n}`)); console.log(""); }

  if (!valid) {
    console.log(c.red("This proposal does not validate against the schema:"));
    for (const e of errors) console.log(c.red(`  ${e}`));
    console.log("\nNot offering to write an invalid config. Fix the evidence or write .nomarmy.yml by hand.");
    process.exit(1);
  }

  if (!process.stdin.isTTY) throw new Error("nomarmy init needs an interactive terminal to confirm the write, or --json --write for a non-interactive one.");
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(c.bold(`Write this to ${path.basename(targetPath)}? [y/N] `))).trim().toLowerCase();
    if (answer !== "y") { console.log(c.dim("Canceled; nothing written.")); return; }
    fs.writeFileSync(targetPath, stringifyConfig(proposal));
    console.log(c.green(`✓ Wrote ${targetPath}.`) + " Run 'nomarmy validate' any time to re-check it.");
  } finally {
    rl.close();
  }
}

// This file's own location, not --repo (the target repo being scanned) --
// setup/model need to find THIS package's config/ and scripts/ as siblings
// of bin/, the same way select-model.mjs resolves its own root.
// fileURLToPath, not URL.pathname: on Windows that gave "/C:/Users/Jason%20Pugh/...",
// a stray slash and an encoded space, and connect failed copying from C:\\C:\\...
const nomarmyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read one KEY=VALUE line's value, or null if the file or key doesn't exist. */
function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  const m = fs.readFileSync(filePath, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

// Your settings live in ~/.config/nomarmy/, over the package's config/
// defaults, so an update can't reset them (lib/user-config.mjs).
const setting = (key) => readSetting(key, { nomarmyRoot });

// Each entry's repo/quant/alias is verified against this project's own real
// usage (downloaded, loaded, dispatched against), not guessed from a model
// card. `thinking` records whether the model has a reasoning mode at all --
// Coder-Next does not, the other two do, at reasoning: medium specifically
// (see docs/experiments/2026-09-20-model-bakeoff-and-economics.md): high
// reasoning was a strict downgrade on every model tested, from a full
// timeout (Qwen3.6-27B on an open-ended task) to a 5x slowdown with real
// failures (gpt-oss-20b: 318s/4 failures at high vs 62s/0 failures at
// medium on an identical ticket). `recommended` is this project's own
// honest opinion given everything measured so far, not a formula -- it
// prints as a note, never a hidden default no one chose.
/**
 * Ask a question and keep re-asking until the answer matches `pattern` (or
 * is blank and `allowEmpty`, returning `fallback`) -- validated ON THE SPOT,
 * not left to fail only at the very end via schema validation with no
 * indication of which of several answers was the problem.
 */
/** A numbered choice, asked again until it's one of 1..count (an empty or mistyped answer used to end the whole flow). */
async function askChoice(rl, count) {
  const answer = await askUntilValid(rl, "Choice: ", { pattern: new RegExp(`^([1-9]|[1-9][0-9])$`), invalidMessage: `Choose a number from 1 to ${count}.` });
  if (Number(answer) >= 1 && Number(answer) <= count) return Number(answer) - 1;
  console.log(c.red(`  ✗ Choose a number from 1 to ${count}.`));
  return askChoice(rl, count);
}

async function askUntilValid(rl, prompt, { pattern, invalidMessage, allowEmpty = false, fallback = "" }) {
  for (;;) {
    const answer = (await rl.question(c.bold(prompt))).trim();
    if (!answer && allowEmpty) return fallback;
    if (pattern.test(answer)) return answer;
    console.log(c.red(`  ✗ ${invalidMessage}`));
  }
}

/**
 * Like rl.question, for a real secret typed directly into the terminal
 * rather than exported as an env var first. NOT masked: the classic
 * "monkey-patch readline's private write hook" trick relies on
 * `_writeToOutput`, which the callback-based `readline.Interface` exposes
 * but this project's promises-based one (`node:readline/promises`,
 * confirmed directly against this Node version) does not -- and a
 * hand-rolled raw-mode character reader is exactly the kind of thing that's
 * unsafe to ship without testing against a real interactive terminal, which
 * this environment cannot do. So this echoes plainly, like every other
 * question in this file, and says so up front rather than silently doing
 * something fragile. The value is still never written to config/
 * agents.yml or any other file -- it's held in memory for the one
 * immediate registration call and discarded.
 */
async function askSecret(rl, prompt) {
  console.log(c.yellow("(this will be visible as you type it -- not masked, not sent anywhere, not saved to a file)"));
  const answer = await rl.question(c.bold(prompt));
  return answer.trim();
}

const KNOWN_MODELS = {
  default: {
    label: "Qwen3-Coder-Next · 48 GB download · the most reliable in our tests (recommended)",
    repo: "Qwen/Qwen3-Coder-Next-GGUF", quant: "Q4_K_M", alias: "qwen3-coder-next", thinking: false, recommended: true,
  },
  "gpt-oss-20b": {
    label: "gpt-oss-20b · 12 GB download · the fastest; keep reasoning at medium",
    repo: "ggml-org/gpt-oss-20b-GGUF", quant: "MXFP4", alias: "gpt-oss-20b", thinking: true,
  },
  "qwen3.6-27b": {
    label: "Qwen3.6-27B · 17 GB download · very reliable, slower; keep reasoning at medium",
    repo: "unsloth/Qwen3.6-27B-GGUF", quant: "Q4_K_M", alias: "qwen3.6-27b", thinking: true,
  },
};

/**
 * The one model-choice menu both `setup` and `model` show. Returns
 * `{ kind: "known", repo, quant, alias, thinking }` for a curated entry, or
 * `{ kind: "search" }` once scripts/select-model.mjs (spawned as a child
 * process, not reimplemented -- it already owns the Hugging Face search,
 * confirm and write flow) has finished. A searched model's `thinking`
 * support isn't knowable from a repo/quant alone, so it's asked directly.
 */
async function chooseModel(rl) {
  const entries = Object.entries(KNOWN_MODELS);
  console.log("\n" + c.bold("Which model?"));
  entries.forEach(([, m], i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${m.label}`));
  console.log(`  ${c.cyan(`${entries.length + 1}.`)} Search Hugging Face for something else`);
  const defaultChoice = String(entries.findIndex(([, m]) => m.recommended) + 1 || 1);
  const choice = (await rl.question(c.bold(`Choice [${defaultChoice}]: `))).trim() || defaultChoice;
  const picked = entries[Number(choice) - 1];
  if (picked) return { kind: "known", ...picked[1] };
  const term = (await rl.question("Search term (or owner/model-GGUF repo): ")).trim();
  if (!term) throw new Error("A search term or repo is required for the Hugging Face search path.");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(nomarmyRoot, "scripts", "select-model.mjs"), term], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`select-model.mjs exited ${code}`))));
    child.on("error", reject);
  });
  const thinkingAnswer = (await rl.question(c.bold("Does this model have a thinking/reasoning mode? [y/N] "))).trim().toLowerCase();
  return { kind: "search", thinking: thinkingAnswer === "y" || thinkingAnswer === "yes" };
}

function setupProjectDir() {
  let project = process.cwd();
  while (!fs.existsSync(path.join(project, ".git"))) {
    const parent = path.dirname(project);
    if (parent === project) { project = null; break; }
    project = parent;
  }
  return project;
}

/** The profile install.sh picks when given none (scripts/lib.sh load_profile). */
function defaultLocalProfile() {
  if (process.platform === "darwin") return "macbook-pro";
  return spawnSync("nvidia-smi", ["-L"], { stdio: "ignore", timeout: 5000 }).status === 0 ? "nvidia-linux" : "cpu-linux";
}

// Which profile this machine is set up for, the same way for `setup` and
// `install`: the one setup recorded, else the install marker's, else the
// execution mode's, else (a working local install) install.sh's default.
function setupProfileState() {
  const common = userCommonPath();
  const chosen = setting("NOMARMY_SETUP_PROFILE");
  const probeCommand = (binary, args) => {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 10000 });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const profileFile = profilePathFor(chosen, { nomarmyRoot });
  const root = (process.env.NOMARMY_INSTALL_ROOT || (profileFile && readEnvValue(profileFile, "NOMARMY_INSTALL_ROOT")) || setting("NOMARMY_INSTALL_ROOT") || "$HOME/.local/share/nomarmy-local-agents").replace(/\$HOME|\$\{HOME\}/g, os.homedir());
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(root, "install.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") marker = {}; }
  const version = probeCommand("openclaw", ["--version"]);
  // `mcp list` would connect to every server; `mcp get` only looks this one up.
  const registered = !marker && Boolean(version) && ["claude", "codex"].some((name) => spawnSync(name, ["mcp", "get", "nomarmy-local-worker"], { stdio: "ignore", timeout: 10000 }).status === 0);
  // An install from before setup recorded its profile: the marker's, else the
  // execution mode's, else (a working local install) install.sh's default.
  const execution = setting("NOMARMY_EXECUTION");
  const profile = chosen ?? marker?.profile
    ?? (["hosted", "remote", "bedrock"].includes(execution) ? execution : null)
    ?? (registered ? defaultLocalProfile() : null);
  return { common, profile, marker, version, registered };
}

function setupChecklist() {
  const { common, profile, marker, version, registered } = setupProfileState();
  const project = setupProjectDir();
  return setupSteps({
    mode: () => ({ profile, host: setting("NOMARMY_LLAMA_HOST"), port: setting("NOMARMY_LLAMA_PORT") }),
    install: () => ({ marker, version, registered }),
    agents: () => Object.keys(loadAgents(globalConfigDir()).agents),
    army: () => {
      const global = readArmyFile(armyLayerPath("global"), { armyOnly: true });
      const local = project ? readArmyFile(armyLayerPath("project", { projectDir: project })) : null;
      const merged = mergeArmy([{ layer: "global", army: global }, { layer: "project", army: local }]).army;
      // Repair the layer that would otherwise keep overriding a global init.
      const repairLayer = profile === "hosted" && Object.values(local?.roles ?? {}).some((role) => role.agent === "local") ? "project" : null;
      return { ...merged, repairLayer };
    },
    repo: () => ({ inside: Boolean(project), configured: Boolean(project && fs.existsSync(path.join(project, ".nomarmy.yml"))) }),
  });
}

function runSetupChild(args) {
  // Work from the repository root even when setup was started in a subdirectory;
  // the child's cwd remains unchanged, as it does for every other step.
  const project = setupProjectDir();
  if (project && ["init", "army"].includes(args[0])) args = [...args, "--repo", project];
  const result = spawnSync(process.execPath, [path.join(nomarmyRoot, "bin", "nomarmy.mjs"), ...args], { stdio: "inherit", cwd: process.cwd() });
  return result.status ?? 1;
}

function cmdInstall() {
  const profile = value("profile", null) ?? setupProfileState().profile;
  if (!profile) throw new Error("Choose a profile first: nomarmy setup --choose (or install --profile <name>).");
  if (!value("profile", null)) console.log(`Installing for profile ${profile} (from nomarmy setup; pass --profile to choose another).`);
  const result = spawnSync("bash", [path.join(nomarmyRoot, "install.sh"), "--profile", profile, ...(flag("no-claude") ? ["--no-claude"] : [])], { stdio: "inherit", cwd: nomarmyRoot });
  process.exitCode = result.status ?? 1;
}

async function cmdSetup() {
  if (windowsFrontEnd()) {
    process.exitCode = await windowsSetup(argv, { ask: async (prompt) => {
      const rl = createInterface({ input, output });
      try { return await rl.question(prompt); } finally { rl.close(); }
    } });
    return;
  }
  if (flag("status") || (!flag("choose") && !flag("hosted") && !flag("llama-url") && !json)) {
    if (flag("status") || !process.stdin.isTTY) {
      const steps = setupChecklist();
      return json ? out(steps) : console.log(formatSetupSteps(steps));
    }
    // What's ahead, before the first question: a practice run found setup
    // felt heavy mostly because nothing said how much of it there was.
    if (setupChecklist().find((step) => step.status === "todo")?.id === "mode") {
      console.log(`${c.bold("🍪 nomArmy setup")}\n\nAbout 10 to 20 minutes, one step at a time; stop any time and ${c.cyan("nomarmy setup")} picks up where you left off.`);
      console.log(c.dim("  1. Where models run: your API and subscription agents, or a model on this machine"));
      console.log(c.dim("  2. Install: OpenClaw (runs the models) and Podman (the sandbox every job runs in; on macOS a small VM, about a 1 GB download)"));
      console.log(c.dim("  3. Agents: log in to your subscription or add an API key"));
      console.log(c.dim("  4. Roles, this repo's checks, and a final health check\n"));
    }
    process.exitCode = await runSetupPlaybook({
      evaluate: setupChecklist, print: console.log, run: runSetupChild,
      ask: async (prompt) => {
        const rl = createInterface({ input, output });
        try { return await rl.question(prompt); } finally { rl.close(); }
      },
    });
    return;
  }
  if (flag("choose")) {
    if (!process.stdin.isTTY) throw new Error("setup --choose needs an interactive terminal.");
    const rl = createInterface({ input, output });
    try {
      console.log("1. hosted (API keys and subscriptions, most people)\n2. a local model on this machine\n3. a shared model server\n4. Bedrock");
      const choice = await askUntilValid(rl, "Choice [1]: ", { pattern: /^[1-4]$/, invalidMessage: "Choose 1, 2, 3 or 4.", allowEmpty: true, fallback: "1" });
      if (choice === "1") argv.push("--hosted");
      if (choice === "3") argv.push("--llama-url", (await rl.question("Server URL: ")).trim());
      if (choice === "4") {
        writeSetting("NOMARMY_EXECUTION", "bedrock");
        writeSetting("NOMARMY_SETUP_PROFILE", "bedrock");
        console.log("Next: nomarmy install");
        return;
      }
    } finally { rl.close(); }
  }
  const hosted = flag("hosted");
  const hasLlamaUrl = flag("llama-url");
  if (hosted && hasLlamaUrl) throw new Error("--hosted and --llama-url cannot be used together.");

  if (hosted || hasLlamaUrl) {
    const commonPath = userCommonPath();

    if (hosted) {
      const next = [
        "nomarmy install",
        "nomarmy agents add",
        "nomarmy army init --agent <name>",
      ];
      writeEnvLine(commonPath, "NOMARMY_EXECUTION", "hosted");
      writeEnvLine(commonPath, "NOMARMY_SETUP_PROFILE", "hosted");
      if (json) return out({ written: commonPath, execution: "hosted", next });
      console.log(c.green(`✓ Jobs will run on your API and subscription agents (saved in ${tildePath(commonPath)}).`));
      console.log(c.dim("\nNext:"));
      for (const step of next) console.log(`  ${c.bold(step)}`);
      return;
    }

    const llamaInput = value("llama-url");
    if (!llamaInput) throw new Error("--llama-url requires an http:// URL, for example http://server:8080.");
    const { host: llamaHost, port: llamaPort } = parseLlamaUrl(llamaInput);
    const urlHost = llamaHost.includes(":") ? `[${llamaHost}]` : llamaHost;
    const healthUrl = `http://${urlHost}:${llamaPort}/health`;
    let reachable = false;
    try {
      await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      reachable = true;
    } catch {
      // A server may simply be offline during setup; retain its validated address.
    }
    fs.mkdirSync(path.dirname(commonPath), { recursive: true });
    writeEnvLine(commonPath, "NOMARMY_EXECUTION", "remote");
    writeEnvLine(commonPath, "NOMARMY_SETUP_PROFILE", "remote");
    writeEnvLine(commonPath, "NOMARMY_LLAMA_HOST", llamaHost);
    writeEnvLine(commonPath, "NOMARMY_LLAMA_PORT", llamaPort);
    const next = "nomarmy install";
    if (json) return out({ written: commonPath, execution: "remote", llamaHost, llamaPort, reachable, next });
    console.log(reachable
      ? c.green(`✓ llama-server is reachable at ${healthUrl}.`)
      : c.yellow(`⚠ llama-server is not reachable at ${healthUrl} right now; configuration was still written.`));
    console.log(c.green(`✓ Wrote the remote llama-server settings to ${tildePath(commonPath)}.`));
    console.log(c.dim("\nNext:"));
    console.log(`  ${c.bold(next)}`);
    return;
  }

  const execution = flag("choose") ? "local" : value("execution", process.env.NOMARMY_EXECUTION || "local");
  const isCloud = execution !== "local";
  const hardware = isCloud ? null : await detectHardware();
  const modelPath = isCloud ? null : findModel();
  const gguf = modelPath ? await readGGUFMetadata(modelPath) : { found: false };
  const res = recommend({ hardware, gguf, execution });

  const nonInteractive = json;
  if (nonInteractive && !flag("profile-name")) throw new Error("--json requires --profile-name <name>.");
  if (nonInteractive && !isCloud && !flag("model")) throw new Error(`--json requires --model <${Object.keys(KNOWN_MODELS).join("|")}> for a local profile (Hugging Face search is interactive-only).`);

  let rl = null;
  if (!nonInteractive) {
    if (!process.stdin.isTTY) throw new Error("nomarmy setup needs an interactive terminal, or --json with --profile-name (and --model for a local profile).");
    rl = createInterface({ input, output });
  }

  try {
    if (!json) {
      console.log(c.bold("🍪 nomArmy setup\n"));
      console.log(isCloud
        ? `Execution is '${execution}' -- hosted inference, local hardware does not bound this.\n`
        : `Hardware: ${c.cyan(`${hardware.platform}/${hardware.arch}`)}, ${hardware.cpu?.logicalCores ?? "?"} logical cores, ${(hardware.memory?.totalBytes / 1024 ** 3).toFixed(1)} GiB RAM\n`);
      // Plain words; the exact settings are shown before anything is written.
      const plain = (env) => { const n = Number(env?.NOMARMY_MAX_WORKERS ?? env?.NOMARMY_LLAMA_PARALLEL ?? 1), ctx = Math.round(Number(env?.NOMARMY_LLAMA_CONTEXT ?? 0) / Math.max(1, Number(env?.NOMARMY_LLAMA_PARALLEL ?? 1)) / 1024); return `${n} local job${n === 1 ? "" : "s"} at a time${ctx ? `, ${ctx}K tokens of context each` : ""}`; };
      console.log(`This machine fits ${c.green(plain(res.env))}${res.confidence === "low" ? c.dim(" (an estimate)") : ""}.`);
      if (res.nominal && !res.nominal.fits) console.log(c.red("Even one local job doesn't fit in this machine's memory: choose hosted instead (nomarmy setup --choose)."));
    }

    // "More noms" fits as many noms as memory allows; "nominal" is 1 worker
    // at the same context, matching every profile actually shipped in
    // config/profiles/*.env. No genuinely distinct third "fast" tier is
    // offered: worker count is the only speed-relevant lever this project
    // has real (measured, README-documented) data for, and a smaller
    // context per nom has no established speed relationship in this
    // codebase, only a memory one -- inventing one would be a guess
    // presented as a measurement.
    let sizingTier = "more";
    if (res.nominal && !res.nominal.sameAsRecommended) {
      if (nonInteractive) {
        sizingTier = value("tier", "more");
        if (sizingTier !== "more" && sizingTier !== "nominal") throw new Error('--tier must be "more" or "nominal".');
      } else {
        console.log(`\n${c.bold("Which sizing?")}`);
        console.log(`  ${c.cyan("1.")} As many at once as fit in memory`);
        console.log(`  ${c.cyan("2.")} One at a time (lighter on the machine)`);
        const choice = (await rl.question(c.bold("Choice [1]: "))).trim() || "1";
        sizingTier = choice === "2" ? "nominal" : "more";
      }
    }
    const sizingEnv = sizingTier === "nominal" ? res.nominal.env : res.env;

    let model = null;
    if (!isCloud) {
      if (nonInteractive) {
        const which = value("model");
        if (!KNOWN_MODELS[which]) throw new Error(`--model must be one of ${Object.keys(KNOWN_MODELS).join(", ")} under --json, got "${which}".`);
        model = { kind: "known", ...KNOWN_MODELS[which] };
      } else {
        model = await chooseModel(rl);
      }
    }

    const profileName = nonInteractive ? value("profile-name") : (await rl.question(`\nProfile name [${hardware?.appleSilicon ? "macbook-pro" : "custom"}]: `)).trim() || (hardware?.appleSilicon ? "macbook-pro" : "custom");
    const profilePath = userProfilePath(profileName);
    const commonPath = userCommonPath();

    const profileWrites = { ...sizingEnv };
    if (!isCloud) {
      // recommend() only returns context/parallel/worker counts -- every
      // hand-authored profile also sets these two, and start-inference.sh
      // references both unconditionally under `set -euo pipefail`, so a
      // profile missing them fails outright on first use, not gracefully.
      profileWrites.NOMARMY_LLAMA_GPU_LAYERS = (hardware.gpu?.count > 0 || hardware.platform === "darwin") ? 999 : 0;
      profileWrites.NOMARMY_LLAMA_THREADS = hardware.cpu?.physicalCores ?? hardware.cpu?.logicalCores ?? 4;
    }

    if (!json) {
      console.log(c.bold(`\nAbout to write ${tildePath(profilePath)}:`));
      for (const [k, v] of Object.entries(profileWrites)) console.log(c.dim(`  ${k}=${v}`));
      if (model?.kind === "known") {
        console.log(c.bold(`\nAnd ${tildePath(commonPath)}:`));
        console.log(c.dim(`  NOMARMY_MODEL_REPO=${model.repo}`));
        console.log(c.dim(`  NOMARMY_MODEL_QUANT=${model.quant}`));
        console.log(c.dim(`  NOMARMY_MODEL_ALIAS=${model.alias}`));
        console.log(c.dim(`  NOMARMY_WORKER_MODEL=${model.alias}`));
        console.log(c.dim(`  NOMARMY_MODEL_THINKING=${model.thinking}`));
      }
      if (!nonInteractive) {
        // Yes by default: someone who accepted every suggestion shouldn't lose it all at the last Enter.
        const answer = (await rl.question(c.bold("\nWrite this configuration? [Y/n] "))).trim().toLowerCase();
        if (answer === "n" || answer === "no") { console.log(c.dim("Canceled; nothing written.")); return; }
      }
    }

    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    for (const [k, v] of Object.entries(profileWrites)) writeEnvLine(profilePath, k, v);
    writeEnvLine(commonPath, "NOMARMY_EXECUTION", execution);
    if (execution === "local") writeEnvLine(commonPath, "NOMARMY_LLAMA_HOST", "127.0.0.1");
    writeEnvLine(commonPath, "NOMARMY_SETUP_PROFILE", execution === "bedrock" ? "bedrock" : profileName);
    if (model?.kind === "known" && model.repo) {
      writeEnvLine(commonPath, "NOMARMY_MODEL_REPO", model.repo);
      writeEnvLine(commonPath, "NOMARMY_MODEL_QUANT", model.quant);
    }
    if (model?.kind === "known") {
      writeEnvLine(commonPath, "NOMARMY_MODEL_ALIAS", model.alias);
      // The keys `nomarmy connect` actually reads to route worker dispatch --
      // writing NOMARMY_MODEL_ALIAS alone (the old behavior) left the MCP
      // registration permanently pointed at whatever it last had, regardless
      // of what was chosen here.
      writeEnvLine(commonPath, "NOMARMY_WORKER_MODEL", model.alias);
      writeEnvLine(commonPath, "NOMARMY_MODEL_THINKING", String(model.thinking));
    } else if (model?.kind === "search") {
      const searchedAlias = setting("NOMARMY_MODEL_ALIAS");
      if (searchedAlias) {
        writeEnvLine(commonPath, "NOMARMY_WORKER_MODEL", searchedAlias);
        writeEnvLine(commonPath, "NOMARMY_MODEL_THINKING", String(model.thinking));
      }
    }

    const installCmd = "nomarmy install";
    if (json) return out({ written: { profile: profilePath, common: model?.kind === "known" ? commonPath : null }, env: profileWrites, sizingTier, installCommand: installCmd });
    console.log(c.green(`\n✓ Wrote ${tildePath(profilePath)}${model?.kind === "known" ? ` and ${tildePath(commonPath)}` : ""}.`));
    console.log(c.dim("\nThis proposes; it does not install. Run:\n"));
    console.log(`  ${c.bold(installCmd)}\n`);
  } finally {
    rl?.close();
  }
}

/**
 * `nomarmy model`: swap the configured model later without re-running the
 * whole `setup` wizard. Same menu `setup` offers; never restarts inference
 * itself, matching every other "propose a config change" command in this
 * CLI.
 */
// The third layer this closes, alongside NOMARMY_WORKER_MODEL/--update-mcp
// above: writing config/common.env and resyncing the MCP registration still
// leaves the ACTUAL RUNNING llama-server serving whatever model it loaded
// at its own last start -- a real, confirmed incident (config said
// Qwen3.6-27B, the live process was still gpt-oss-20b 11 minutes later,
// and a delegated worker correctly refused to guess a launch command or
// kill a 13.7GB process without authorization rather than silently doing
// nothing). stop/start-inference.sh already no-op harmlessly on a cloud
// profile and auto-detect the profile from the OS when none is given
// (see lib.sh's load_profile), so this needs no profile argument itself.
function restartInference() {
  runScript("stop-inference.sh", []);
  runScript("start-inference.sh", []);
}
async function cmdModel() {
  const commonPath = userCommonPath();
  if (json) {
    const which = value("model");
    if (!KNOWN_MODELS[which]) throw new Error(`--json requires --model one of ${Object.keys(KNOWN_MODELS).join(", ")} (Hugging Face search is interactive-only).`);
    const m = KNOWN_MODELS[which];
    if (m.repo) { writeEnvLine(commonPath, "NOMARMY_MODEL_REPO", m.repo); writeEnvLine(commonPath, "NOMARMY_MODEL_QUANT", m.quant); }
    writeEnvLine(commonPath, "NOMARMY_MODEL_ALIAS", m.alias);
    writeEnvLine(commonPath, "NOMARMY_WORKER_MODEL", m.alias);
    writeEnvLine(commonPath, "NOMARMY_MODEL_THINKING", String(m.thinking));
    // Same destructive-action-needs-explicit-opt-in-under-json rule as
    // uninstall's --clear-*: this runs claude mcp remove/add for real.
    if (flag("update-mcp")) connectClaude({ nomarmyRoot, run: (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "ignore", ...opts }) });
    // Also real and destructive (kills the running llama-server, however
    // briefly) -- same opt-in-under-json rule.
    if (flag("restart-inference")) restartInference();
    return out({ written: commonPath, model: m, mcpUpdated: flag("update-mcp"), inferenceRestarted: flag("restart-inference") });
  }
  if (!process.stdin.isTTY) throw new Error(`nomarmy model needs an interactive terminal, or --json --model <${Object.keys(KNOWN_MODELS).join("|")}> (add --update-mcp to also resync the MCP registration, --restart-inference to also reload the running local model).`);
  const rl = createInterface({ input, output });
  try {
    console.log(c.bold("🍪 nomArmy model"));
    const model = await chooseModel(rl);
    let alias;
    if (model.kind === "search") {
      console.log(c.green("\n✓ Done") + ` -- ${tildePath(commonPath)} was already updated by the search above.`);
      alias = setting("NOMARMY_MODEL_ALIAS");
    } else {
      console.log(c.bold(`\nAbout to write ${tildePath(commonPath)}:`));
      console.log(c.dim(`  NOMARMY_MODEL_REPO=${model.repo}\n  NOMARMY_MODEL_QUANT=${model.quant}\n  NOMARMY_MODEL_ALIAS=${model.alias}`));
      const answer = (await rl.question(c.bold("\nApply this model configuration? [y/N] "))).trim().toLowerCase();
      if (answer !== "y") { console.log(c.dim("Canceled; nothing changed.")); return; }
      writeEnvLine(commonPath, "NOMARMY_MODEL_REPO", model.repo);
      writeEnvLine(commonPath, "NOMARMY_MODEL_QUANT", model.quant);
      writeEnvLine(commonPath, "NOMARMY_MODEL_ALIAS", model.alias);
      console.log(c.green(`✓ Wrote ${tildePath(commonPath)}.`));
      alias = model.alias;
    }
    if (alias) {
      writeEnvLine(commonPath, "NOMARMY_WORKER_MODEL", alias);
      writeEnvLine(commonPath, "NOMARMY_MODEL_THINKING", String(model.thinking));
    }

    // The gap this closes: NOMARMY_WORKER_MODEL above was, until now, never
    // read back by anything -- picking a model here had no effect on which
    // model workers actually dispatched to until someone separately, and
    // manually, re-ran the MCP registration by hand.
    if (alias && commandExists("claude")) {
      const answer = (await rl.question(c.bold(`\nAlso update the Claude Code MCP registration to use "${alias}" now? [y/N] `))).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
        connectClaude({ nomarmyRoot, run });
        console.log(c.green("✓ MCP registration updated.") + " Restart your Claude Code session to pick this up (the MCP server is a per-session child process).");
      }
    }

    // The third layer: config/common.env and the MCP registration can both
    // now say the right model while the actually-running llama-server keeps
    // serving whatever it loaded at its own last start, unnoticed until
    // something fails against the wrong model.
    if (alias) {
      const answer = (await rl.question(c.bold(`\nAlso restart local inference now to load "${alias}"? [y/N] `))).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        restartInference();
      } else {
        console.log(c.dim("Skipped -- restart inference yourself when ready:\n  nomarmy stop\n  nomarmy start"));
      }
    }
  } finally {
    rl.close();
  }
}

// One label/default per api provider type the `nomarmy agents add api` menu shows.
// `native: true` types register through OpenClaw's own dedicated onboarding
// flag (--anthropic-api-key etc, verified via `openclaw onboard --help`);
// the rest register as a custom endpoint (the same mechanism
// scripts/configure-openclaw.sh already uses for Bedrock) and need base_url.
const KNOWN_PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-6", authEnvSuggestion: "NOMARMY_ANTHROPIC_API_KEY", native: true },
  openai: { label: "OpenAI", defaultModel: "gpt-5.6-terra", authEnvSuggestion: "NOMARMY_OPENAI_API_KEY", native: true },
  xai: { label: "xAI (Grok)", defaultModel: "grok-build-0.1", authEnvSuggestion: "NOMARMY_XAI_API_KEY", native: true },
  deepinfra: { label: "DeepInfra", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", authEnvSuggestion: "NOMARMY_DEEPINFRA_API_KEY", native: true },
  openclaw: { label: "Any other OpenClaw provider (DeepSeek, Mistral, Groq, ... -- by its OpenClaw id)", native: true },
  bedrock: { label: "AWS Bedrock (custom OpenAI-compatible endpoint)", defaultModel: "amazon.nova-micro-v1:0", authEnvSuggestion: "NOMARMY_BEDROCK_API_KEY", native: false, baseUrlHint: "https://bedrock-runtime.<region>.amazonaws.com/openai/v1" },
  "azure-openai": { label: "Azure OpenAI", defaultModel: "gpt-4o-mini", authEnvSuggestion: "NOMARMY_AZURE_OPENAI_API_KEY", native: false, baseUrlHint: "https://YOUR-RESOURCE.openai.azure.com" },
  "openai-compatible": { label: "Custom OpenAI-compatible endpoint", defaultModel: "", authEnvSuggestion: "NOMARMY_CUSTOM_API_KEY", native: false, baseUrlHint: "https://example.com/v1" },
  "llama-cpp": { label: "Local llama.cpp server (already configured -- adds it to a pool alongside remote providers)", native: false },
};

/**
 * Registers one provider entry with OpenClaw. The credential is ALWAYS
 * piped via stdin, never passed as a CLI argument -- a bare argv value is
 * visible to any other process on this machine for the child's lifetime
 * (`ps aux`/`/proc/<pid>/cmdline`), which an earlier version of this
 * function got wrong for native providers specifically (--anthropic-api-key
 * <key> as a literal argument), a real regression against the discipline
 * scripts/configure-openclaw.sh already established for Bedrock/local.
 * `openclaw models auth paste-api-key --provider <id>` is that same
 * stdin-piped primitive, used uniformly here for every provider type.
 * Custom endpoints (bedrock/azure-openai/openai-compatible) additionally
 * need `openclaw onboard --custom-*` first to define the provider's shape
 * (base URL, model id) before a credential can attach to it; native
 * providers (anthropic/openai/xai/deepinfra, or any id via the generic
 * `openclaw` type) are already known to OpenClaw, or become known once the
 * entry's `plugin` is installed, and skip straight to the credential step. On failure, the raw exec error
 * is deliberately never printed -- Node's own error message embeds the
 * full child command line, which for a failed `paste-api-key` call would
 * otherwise still be safe (the key was on stdin, not argv) but is not worth
 * trusting blindly across every future code path this function might grow.
 */
// Takes a pool entry in its REAL, on-disk shape (snake_case auth_env/
// base_url, exactly what config/providers.yml and the schema use) rather
// than a translated camelCase copy -- a prior version of this function
// destructured `authEnv`/`baseUrl` while every real entry object actually
// carries `auth_env`/`base_url`, so both were silently always undefined at
// every call site and the piped credential was the literal string "null".
function registerProviderWithOpenClaw({ id, provider, model, auth_env: authEnv, base_url: baseUrl, openclaw_provider: genericId, plugin, apiKeyOverride }) {
  // apiKeyOverride is the value from askSecret's "enter it now instead"
  // path -- checked first so a key typed directly into the wizard is used
  // immediately, without also requiring it be exported first.
  const apiKey = apiKeyOverride || (authEnv ? process.env[authEnv] : null);
  if (!apiKey) {
    console.log(c.red(authEnv
      ? `✗ ${authEnv} is not set in this shell -- export it, then run this registration again.`
      : "✗ No credential available to register (no auth_env on this entry and none entered)."));
    return false;
  }
  const isNative = isNativeProviderType(provider);
  const authProviderId = isNative ? openclawProviderId({ provider, openclaw_provider: genericId }) : id;
  const skipFlags = ["--skip-daemon", "--skip-channels", "--skip-skills", "--skip-search", "--skip-hooks", "--skip-ui"];
  // Override point for tests (and for an operator pointing at a specific
  // openclaw binary/path rather than relying on PATH resolution).
  const openclawCmd = process.env.NOMARMY_OPENCLAW_CMD || "openclaw";
  try {
    // Official plugins register under their provider's id (meta, codex,
    // deepseek -- confirmed live), so inspecting by that id is the
    // already-installed check; installing an installed plugin errors out.
    if (plugin && spawnSync(openclawCmd, ["plugins", "inspect", authProviderId], { stdio: "ignore" }).status !== 0) {
      console.log(c.dim(`Installing OpenClaw plugin ${plugin}...`));
      execFileSync(openclawCmd, ["plugins", "install", plugin], { stdio: "inherit" });
      spawnSync(openclawCmd, ["plugins", "registry", "--refresh"], { stdio: "ignore" });
    }
    if (!isNative) {
      execFileSync(openclawCmd, ["onboard", "--non-interactive", "--accept-risk",
        "--custom-base-url", baseUrl, "--custom-model-id", model, "--custom-provider-id", id, "--custom-compatibility", "openai", ...skipFlags], { stdio: "ignore" });
    }
    execFileSync(openclawCmd, ["models", "auth", "paste-api-key", "--provider", authProviderId, "--profile-id", `${authProviderId}:nomarmy`],
      { input: `${apiKey}\n`, stdio: ["pipe", "ignore", "ignore"] });
    console.log(c.green(`✓ Registered "${id}" with OpenClaw.`));
    console.log(c.yellow(`This project has not run a real job against this specific provider type yet -- run \`openclaw models list --provider ${authProviderId}\` to confirm it registered as expected, then dispatch one real job against this pool before trusting it in production.`));
    return true;
  } catch (error) {
    console.log(c.red(`✗ Registration failed (exit ${error.status ?? "?"}). Run the equivalent \`openclaw onboard\` / \`openclaw models auth paste-api-key --provider ${authProviderId}\` commands by hand to see the real error -- it is not repeated here, since a raw exec error can embed a full child command line and this one is not worth trusting blindly not to.`));
    return false;
  }
}

// --- subscription setup (`agents add subscription <vendor>`): wrap every OpenClaw step
//
// The operator shouldn't need to know OpenClaw exists for the common case.
// Each helper below runs one real command, reports what it found in plain
// terms, and only prompts when something actually needs doing. Logins use
// stdio: "inherit" deliberately: they are device-auth/OAuth flows a human
// completes in a browser (`openclaw models auth login` refuses outright
// without a TTY, confirmed live) -- nomArmy starts the flow, the vendor CLI
// and OpenClaw do the authenticating, and nomArmy never sees a token.

function openclawCmd() { return process.env.NOMARMY_OPENCLAW_CMD || "openclaw"; }

// stdout AND stderr, on success too: `codex login status` prints its
// "Logged in using ChatGPT" line to stderr (confirmed live), and an earlier
// version that kept only stdout on a zero exit read that as "not logged
// in" -- then told a user who had just logged in successfully that they
// still weren't.
function runQuiet(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: !result.error && result.status === 0, out, stdout: result.stdout ?? "", status: result.status };
}

function runInteractive(cmd, args) {
  try { execFileSync(cmd, args, { stdio: "inherit" }); return true; }
  catch { return false; }
}

async function confirm(rl, question, { defaultYes = true } = {}) {
  const answer = (await rl.question(c.bold(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `))).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/** The vendor CLI's own login state: its status command, or (Muse Code, which has none) its non-secret descriptor file. */
function readLoginStatus(vendorKey) {
  const cli = SUBSCRIPTION_VENDORS[vendorKey].cli;
  if (cli.statusArgs) return parseCliLoginStatus(vendorKey, runQuiet(cli.bin, cli.statusArgs).out);
  let text = "";
  try { text = fs.readFileSync(cli.statusFile.replace(/^~(?=\/)/, os.homedir()), "utf8"); } catch { /* missing = not logged in */ }
  return parseMuseAuthDescriptor(text);
}

/**
 * credential.kind "minted-key": copies the key the vendor CLI's own login
 * minted into the OS keychain over to OpenClaw, keychain -> this process ->
 * `paste-api-key` stdin. Never printed, never on argv, never written to a
 * file nomArmy owns; child stdio is discarded so no error path can echo it.
 * Run on every setup, not just the first: the vendor may rotate the key,
 * and a stale copy in OpenClaw fails exactly like a missing one.
 */
function syncMintedKey(vendor) {
  const { keychain, profileId } = vendor.credential;
  if (process.platform !== "darwin") {
    console.log(c.red(`✗ Reading ${vendor.cli.bin}'s stored key is only wired up for the macOS keychain so far. On this OS, link it yourself: \`openclaw models auth paste-api-key --provider ${vendor.provider} --profile-id ${profileId}\` and paste the key it minted.`));
    return false;
  }
  // macOS may show its own keychain prompt here, asking whether to let
  // `security` read this item -- that's the OS asking the operator, as it should.
  const read = spawnSync("security", ["find-generic-password", "-s", keychain.service, "-a", keychain.account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const key = read.status === 0 ? extractMintedKey(read.stdout.trim(), keychain.field) : null;
  if (!key) {
    console.log(c.red(`✗ Couldn't find a usable ${vendor.cli.bin} key in the keychain (or access was declined). Run \`${vendor.cli.bin} ${vendor.cli.loginArgs.join(" ")}\` again, then re-run this.`));
    return false;
  }
  const pasted = spawnSync(openclawCmd(), ["models", "auth", "paste-api-key", "--provider", vendor.provider, "--profile-id", profileId], { input: `${key}\n`, stdio: ["pipe", "ignore", "ignore"] });
  if (pasted.status !== 0) {
    console.log(c.red(`✗ OpenClaw didn't accept the key (exit ${pasted.status ?? "?"}). Run \`openclaw models auth paste-api-key --provider ${vendor.provider} --profile-id ${profileId}\` by hand to see why.`));
    return false;
  }
  runQuiet(openclawCmd(), ["plugins", "registry", "--refresh"]);
  return true;
}

/**
 * Makes one vendor's credential usable by OpenClaw, installing/updating/
 * logging in only what's actually missing. Returns { ok, email } -- email is
 * the vendor CLI's own logged-in account when it reports one, used to
 * default the worker's owner so the operator never retypes who they are.
 */
async function ensureVendorAuth(rl, vendorKey) {
  const vendor = SUBSCRIPTION_VENDORS[vendorKey];
  const step = (text) => console.log(`\n${c.bold("→")} ${text}`);

  step(`${vendor.cli.bin} CLI`);
  if (!runQuiet(vendor.cli.bin, ["--version"]).ok) {
    if (!vendor.cli.npmPackage) {
      console.log(c.red(`✗ \`${vendor.cli.bin}\` isn't installed. ${vendor.cli.installHint}, then run this again.`));
      return { ok: false };
    }
    if (!(await confirm(rl, `\`${vendor.cli.bin}\` isn't installed. Install ${vendor.cli.npmPackage} now?`))) return { ok: false };
    if (!runInteractive("npm", ["install", "-g", vendor.cli.npmPackage])) {
      console.log(c.red(`✗ Install failed. Run \`${vendor.cli.installHint}\` yourself to see why.`));
      return { ok: false };
    }
  }
  console.log(c.green(`✓ ${vendor.cli.bin} is installed.`));

  let status = readLoginStatus(vendorKey);
  if (!status.loggedIn) {
    console.log(c.yellow(`You're not logged in to ${vendor.cli.bin} yet -- this opens its own login (a browser or a device code).`));
    if (!(await confirm(rl, "Log in now?"))) { console.log(c.red(`✗ Sign-in canceled. Retry with \`nomarmy agents add subscription ${vendorKey}\`.`)); return { ok: false }; }
    const loginOk = runInteractive(vendor.cli.bin, vendor.cli.loginArgs);
    if (!loginOk) { console.log(c.red(`✗ ${vendor.cli.bin} sign-in failed or was canceled. Retry with \`nomarmy agents add subscription ${vendorKey}\`.`)); return { ok: false }; }
    status = readLoginStatus(vendorKey);
    if (!status.loggedIn) { console.log(c.red(`✗ Still not logged in to ${vendor.cli.bin}. Retry with \`nomarmy agents add subscription ${vendorKey}\`.`)); return { ok: false }; }
  }
  console.log(c.green(`✓ Logged in to ${vendor.cli.bin}${status.email ? ` as ${status.email}` : ""}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}.`));

  if (vendor.plugin) {
    step("OpenClaw plugin");
    const version = parseOpenclawVersion(runQuiet(openclawCmd(), ["--version"]).out);
    if (!versionAtLeast(version, PINNED_OPENCLAW_VERSION)) {
      const repaired = await repairOpenclaw({
        command: openclawCmd(),
        vendors: configuredSubscriptionVendors(loadAgentsOrExit().agents, [vendorKey]),
        isTTY: Boolean(input.isTTY), ask: (prompt) => rl.question(prompt),
      });
      if (!repaired.ok) return { ok: false };
    }
    if (!runQuiet(openclawCmd(), ["plugins", "inspect", vendor.plugin.id]).ok) {
      console.log(c.dim(`Installing ${vendor.plugin.spec}...`));
      if (!runInteractive(openclawCmd(), ["plugins", "install", vendor.plugin.spec])) {
        console.log(c.red(`✗ Plugin install failed. Run \`openclaw plugins install ${vendor.plugin.spec}\` yourself to see why.`));
        return { ok: false };
      }
      runQuiet(openclawCmd(), ["plugins", "registry", "--refresh"]);
    }
    const checks = verifyOpenclaw({ command: openclawCmd(), vendors: configuredSubscriptionVendors(loadAgentsOrExit().agents, [vendorKey]) });
    const failed = checks.filter((check) => !check.ok);
    if (failed.length) {
      for (const check of failed) console.log(c.red(`✗ ${check.message} Fix: ${check.fix}`));
      return { ok: false };
    }
    console.log(c.green(`✓ OpenClaw's ${vendor.plugin.id} plugin is ready.`));
  }
  if (vendor.credential.kind === "minted-key") {
    step(`Linking your ${vendor.cli.bin} login to OpenClaw`);
    console.log(c.dim(`Copies the key ${vendor.cli.bin}'s own login stored in your keychain into OpenClaw (over stdin, never shown). macOS may ask you to allow it.`));
    if (!syncMintedKey(vendor)) return { ok: false };
    console.log(c.green(`✓ OpenClaw is using your ${vendor.cli.bin} subscription key (profile ${vendor.credential.profileId}).`));
  }
  if (vendor.plugin?.providerConfig) {
    // paste-api-key saves the key but not the provider's config entry; the
    // plugin's own onboarding step writes that (lib/openclaw-config.mjs).
    const applied = await ensureProviderConfig({ provider: vendor.provider, pluginId: vendor.plugin.id, ...vendor.plugin.providerConfig });
    if (applied.error) {
      console.log(c.red(`✗ OpenClaw has no ${vendor.provider} provider entry, and adding it failed: ${applied.error}. Run \`openclaw onboard\` and pick ${vendor.label} to add it.`));
      return { ok: false };
    }
    if (applied.changed) console.log(c.green(`✓ Added the ${vendor.provider} provider to OpenClaw's config with the plugin's own setup step (backup: ${applied.backup}).`));
  }
  return { ok: true, email: status.email };
}

function hasUsableOpenclawAuthProfile(provider) {
  // Same OpenClaw command and JSON shape used by health's login-expiry check.
  const result = runQuiet(openclawCmd(), ["models", "auth", "list", "--json"]);
  if (!result.ok) return false;
  const profiles = parseOpenclawAuthProfiles(result.stdout);
  return profiles?.some((profile) => {
    if (profile.provider !== provider) return false;
    if (profile.expiresAt == null) return true;
    const expires = Date.parse(profile.expiresAt);
    return Number.isFinite(expires) && expires > Date.now();
  }) ?? false;
}

function catalogModelsFor(provider) {
  return parseCatalogModels(runQuiet(openclawCmd(), ["models", "list", "--refresh"]).out, provider);
}

/** One real, one-token completion through OpenClaw to test a model. */
// Why the last probeWorker() call failed, in the vendor's words when it said.
let lastProbeFailure = null;
let lastProbeText = "";
function probeWorker(provider, model) {
  // The route a job takes: the ambient OpenClaw config and a state dir of
  // its own, never --isolated. --isolated skips that config, and with it the
  // Codex runtime ChatGPT-plan jobs run through: gpt-6-sol answered "ok"
  // under --isolated while every job on it failed "not supported when using
  // Codex with a ChatGPT account" (a real Senti run). Under the home
  // directory, since the Podman sandbox only binds paths there.
  const dir = fs.mkdtempSync(path.join(agentStateRoot(), "probe-"));
  const stateDir = path.join(dir, "state"), cwd = path.join(dir, "ws");
  fs.mkdirSync(stateDir); fs.mkdirSync(cwd);
  try {
    const result = spawnSync(openclawCmd(), ["agent", "exec", "Reply with exactly: ok", "--model", `${provider}/${model}`, "--no-auth-env-only",
      "--json", "--cwd", cwd, "--state-dir", stateDir, "--timeout", "90"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd });
    // Streams kept apart: OpenClaw logs a "run ... ended" line to stderr
    // AFTER the JSON envelope, and the merged text doesn't parse.
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const outcome = probeOutcome({ stdout, stderr });
    lastProbeText = `${stderr}\n${stdout}`;
    lastProbeFailure = outcome.ok ? null : outcome.reason;
    if (outcome.ok) recordProbeSuccess(agentStateRoot(), `${provider}/${model}`);
    return outcome.ok;
  } finally {
    reapProbeSandbox(stateDir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function agentStateRoot() {
  const root = process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents");
  fs.mkdirSync(root, { recursive: true });
  return root;
}
// The sandbox container OpenClaw starts for the call is never stopped when
// it returns (mcp/server.mjs reaps each job's the same way, by the hash in
// its state dir).
function reapProbeSandbox(stateDir) {
  let hashes = [];
  try {
    hashes = fs.readdirSync(path.join(stateDir, "sandbox", "skills-workspaces"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^workspace-[0-9a-f]{16,}$/.test(d.name)).map((d) => d.name.slice("workspace-".length));
  } catch { return; }
  for (const hash of hashes) {
    const names = runQuiet("podman", ["ps", "-a", "--filter", `name=${hash}`, "--format", "{{.Names}}"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const name of names) runQuiet("podman", ["rm", "-f", "-v", name]);
  }
}

/**
 * OpenClaw's own provider login, for the vendors whose plugin wants one on
 * top of the vendor CLI's login (Claude doesn't: OpenClaw reuses the CLI
 * session directly). Codex always refreshes its imported copy after CLI
 * login is confirmed; other providers link when catalog or auth checks fail.
 */
async function openclawProviderLogin(vendor, rl) {
  if (vendor === SUBSCRIPTION_VENDORS.codex) return linkCodex({
    run: runQuiet, command: openclawCmd(), isTTY: Boolean(input.isTTY),
    importLogin: flag("link-openclaw"), removeEmailProfiles: flag("remove-email-profiles"),
    confirm: (prompt, opts) => confirm(rl, prompt, opts), print: (message) => console.log(c.dim(message)),
  });
  const provider = vendor.credential.loginProvider ?? vendor.provider;
  console.log(c.dim(`Linking OpenClaw to it (\`openclaw models auth login --provider ${provider}\`) -- follow its prompts:`));
  const ok = runInteractive(openclawCmd(), ["models", "auth", "login", "--provider", provider]);
  runQuiet(openclawCmd(), ["plugins", "registry", "--refresh"]);
  return ok;
}

// --- `nomarmy agents`: every model a job can run on -------------------------
//
// One list in ~/.config/nomarmy/agents.yml (lib/agents.mjs): the local
// model, api keys, and individual subscriptions. `add` walks through what
// each kind needs -- a key registered with OpenClaw, or the vendor's own
// login -- and tests the selected model before saving, with an explicit
// opt-in to save after a failed model call. Changes apply to the next job;
// the MCP server re-reads the file when it changes.

function loadAgentsOrExit() {
  try { return loadAgents(globalConfigDir()); }
  catch (error) { failAgents(error); }
}

function fileAgentsOrExit() {
  try { return readAgentsFile(globalConfigDir()); }
  catch (error) { failAgents(error); }
}

function failAgents(error) {
  if (json) { out({ error: error.message, errors: error.errors ?? [], path: error.path ?? null }); process.exit(1); }
  console.error(c.red(error.errors?.length ? "That isn't a valid agents.yml:" : error.message));
  for (const line of error.errors ?? []) console.error(`  - ${line}`);
  process.exit(1);
}

function saveAgents(agents) {
  try { return writeAgentsFile(globalConfigDir(), agents); }
  catch (error) { failAgents(error); }
}

/** Which roles, in any army layer this repo sees, point at `name`. */
function rolesUsingAgent(name) {
  try {
    const { army } = loadArmy({ projectDir: repoDir });
    return Object.entries(army.roles).filter(([, role]) => role.agent === name).map(([role]) => role);
  } catch {
    return [];
  }
}

function parseThinkingAnswer(answer, fallback) {
  const a = answer.trim().toLowerCase();
  if (!a) return fallback;
  if (THINKING_LEVELS.includes(a)) return a;
  return !(a === "n" || a === "no");
}

/**
 * For each agent: the roles pointing at it in this repo's merged army
 * (with each role's model), and whether it's the General. Empty when the
 * army doesn't load -- `army show` reports why.
 */
function agentAssignments() {
  const byAgent = {};
  try {
    const { army } = loadArmy({ projectDir: repoDir });
    if (army.general) (byAgent[army.general] ??= { general: true, roles: [] }).general = true;
    for (const [role, r] of Object.entries(army.roles)) {
      if (!r.agent) continue;
      (byAgent[r.agent] ??= { general: false, roles: [] }).roles.push({ role, model: r.model ?? null });
    }
  } catch { /* army problems are army show's to report */ }
  return byAgent;
}

async function cmdAgentsList() {
  const loaded = loadAgentsOrExit();
  const assigned = agentAssignments();
  if (json) return out({ found: loaded.found, path: loaded.path, agents: loaded.agents, assignments: assigned });
  console.log(c.bold("🍪 nomArmy agents") + c.dim(`  (${loaded.found ? loaded.path : `no agents.yml yet; it will live at ${loaded.path}`})`));
  const width = Math.max(...Object.keys(loaded.agents).map((n) => n.length), 5) + 2;
  const inFile = fileAgentsOrExit();
  for (const [name, agent] of Object.entries(loaded.agents)) {
    const extra = agent.kind === "api" ? c.dim(`  key: ${agent.auth_env}`) : !Object.prototype.hasOwnProperty.call(inFile, name) ? c.dim("  built in") : "";
    console.log(`  ${c.cyan(name.padEnd(width))} ${describeAgentLabel(agent)}${extra}`);
    const a = assigned[name];
    const uses = [
      ...(a?.general ? [c.bold("the General")] : []),
      ...(a?.roles ?? []).map((r) => `${r.role}${r.model ? ` (${r.model === "auto" ? "auto" : r.model})` : agent.model ? ` (${agent.model})` : ""}`),
    ];
    console.log(c.dim(`  ${" ".repeat(width)} ${uses.length ? `used by: ${uses.join(", ")}` : "not used by any role in this repo"}`));
  }
  console.log(c.dim(`\nAdd one with \`nomarmy agents add\`. Give roles an agent with \`nomarmy army assign <role> <agent>\`, or dispatch with agent: "<name>".`));
}

async function cmdAgentsRemove() {
  const name = argv[2];
  if (!name) throw new Error("Usage: nomarmy agents remove <name>");
  const agents = fileAgentsOrExit();
  if (!Object.prototype.hasOwnProperty.call(agents, name)) {
    throw new Error(name === "local" ? "`local` is built in and can't be removed." : `Unknown agent "${name}". Your agents: ${Object.keys(loadAgentsOrExit().agents).join(", ")}`);
  }
  const usedBy = rolesUsingAgent(name);
  if (!json) {
    if (usedBy.length) console.log(c.yellow(`Roles using "${name}" in this repo: ${usedBy.join(", ")}. They'll be refused until you reassign them.`));
    const rl = createInterface({ input, output });
    try { if (!(await confirm(rl, `Remove agent "${name}"?`, { defaultYes: false }))) { console.log(c.dim("Canceled; nothing changed.")); return; } }
    finally { rl.close(); }
  }
  const next = { ...agents };
  delete next[name];
  saveAgents(next);
  if (json) return out({ removed: true, name, rolesStillUsingIt: usedBy });
  console.log(c.green(`✓ Removed agent "${name}".`));
}

// --- add ---

async function cmdAgentsAdd() {
  if (json) return cmdAgentsAddJson();
  if (!process.stdin.isTTY) throw new Error("nomarmy agents add needs an interactive terminal (subscription logins open a browser), or --json with explicit flags (see `nomarmy help`).");
  const agents = fileAgentsOrExit();
  const rl = createInterface({ input, output });
  try {
    console.log(c.bold("🍪 nomArmy agents add"));
    let kind = argv[2];
    if (!AGENT_KINDS.includes(kind)) {
      console.log("\n" + c.bold("What kind of agent?"));
      console.log(`  ${c.cyan("1.")} local         ${c.dim("the local model on this machine (no per-token bill, private; slower)")}`);
      console.log(`  ${c.cyan("2.")} api           ${c.dim("a metered API key (xAI, OpenAI, Anthropic, DeepSeek, ...)")}`);
      console.log(`  ${c.cyan("3.")} subscription  ${c.dim("your own Claude, ChatGPT or Muse Code plan (never shared)")}`);
      kind = AGENT_KINDS[await askChoice(rl, AGENT_KINDS.length)];
    }
    if (kind === "local") return await addLocalAgent(rl, agents);
    if (kind === "api") return await addApiAgent(rl, agents);
    return await addSubscriptionAgent(rl, agents);
  } finally {
    rl.close();
  }
}

async function askAgentName(rl, agents, fallback) {
  const name = await askUntilValid(rl, `Agent name [${fallback}]: `, {
    allowEmpty: true, fallback, pattern: ID_RE,
    invalidMessage: "must be 1-64 characters of letters, numbers, dot, underscore or hyphen.",
  });
  if (RESERVED_AGENT_NAMES.includes(name)) throw new Error(`"${name}" is a reserved name.`);
  if (Object.prototype.hasOwnProperty.call(agents, name) && !(await confirm(rl, `"${name}" already exists. Replace it?`, { defaultYes: false }))) return null;
  return name;
}

function savedAgentMessage(name, written) {
  console.log(c.green(`\n✓ Saved agent "${name}": ${describeAgentLabel(written[name])}.`));
  console.log(c.dim(`Use it with \`nomarmy army assign <role> ${name}\` or agent: "${name}" on a job. It applies to the next job, no restart.`));
}

async function addLocalAgent(rl, agents) {
  console.log(c.dim("`local` (the coder slot) is built in. Add another only to name the gpt slot (NOMARMY_WORKER_MODEL_FALLBACK)."));
  const slot = (await rl.question(c.bold("Slot, coder or gpt [gpt]: "))).trim() || "gpt";
  if (!["coder", "gpt"].includes(slot)) throw new Error("Slot must be coder or gpt.");
  const name = await askAgentName(rl, agents, slot === "gpt" ? "local-gpt" : "local");
  if (!name) { console.log(c.dim("Stopped; nothing was written.")); return; }
  savedAgentMessage(name, saveAgents({ ...agents, [name]: { kind: "local", slot } }));
}

async function addApiAgent(rl, agents) {
  console.log("\n" + c.bold("Which provider?"));
  API_PROVIDER_TYPES.forEach((t, i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${KNOWN_PROVIDERS[t]?.label ?? t}`));
  const provider = API_PROVIDER_TYPES[await askChoice(rl, API_PROVIDER_TYPES.length)];
  const info = KNOWN_PROVIDERS[provider] ?? {};
  const agent = { kind: "api", provider };

  if (provider === "openclaw") {
    console.log(c.dim("Any provider OpenClaw can talk to. Find its id with `openclaw models list --all`, or `openclaw plugins search <name>` if it needs a plugin."));
    agent.openclaw_provider = await askUntilValid(rl, "OpenClaw provider id (e.g. deepseek, mistral, groq): ", {
      pattern: OPENCLAW_PROVIDER_ID_RE, invalidMessage: "must be an OpenClaw provider id (lowercase letters, digits, dot, underscore, hyphen).",
    });
    const plugin = (await rl.question(c.bold("Plugin to install first, if it isn't built in (e.g. clawhub:@openclaw/deepseek-provider; blank = none): "))).trim();
    if (plugin) agent.plugin = plugin;
  }
  const name = await askAgentName(rl, agents, agent.openclaw_provider ?? (provider === "xai" ? "grok" : provider));
  if (!name) { console.log(c.dim("Stopped; nothing was written.")); return; }

  const apiModel = (await rl.question(c.bold(`Default model, optional${info.defaultModel ? ` (e.g. ${info.defaultModel})` : ""}; blank = pick per role: `))).trim();
  if (apiModel) agent.model = apiModel;
  const envSuggestion = info.authEnvSuggestion ?? `NOMARMY_${(agent.openclaw_provider ?? name).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  // The variable's NAME, never the key: the key itself goes to OpenClaw's
  // own store over stdin (registerProviderWithOpenClaw) and never into
  // agents.yml or any other file nomArmy writes.
  agent.auth_env = await askUntilValid(rl, `Environment variable NAME for the API key, not the key itself [${envSuggestion}]: `, {
    allowEmpty: true, fallback: envSuggestion, pattern: AUTH_ENV_NAME_RE,
    invalidMessage: "must look like an ENVIRONMENT VARIABLE NAME (uppercase letters, digits, underscores) -- not the key itself.",
  });
  if (["bedrock", "azure-openai", "openai-compatible"].includes(provider)) {
    agent.base_url = (await rl.question(c.bold(`Base URL${info.baseUrlHint ? ` (e.g. ${info.baseUrlHint})` : ""}: `))).trim();
    if (!agent.base_url) throw new Error("A base URL is required for this provider.");
  }
  agent.thinking = parseThinkingAnswer(await rl.question(c.bold("Thinking: Y = follow the job's level (default), n = off, or low/medium/high to always use that: ")), true);
  const cw = (await rl.question(c.bold("Context window in tokens (blank = look it up from OpenClaw's catalog): "))).trim();
  if (cw) agent.context_window = Number(cw);

  let apiKey = null;
  if (!process.env[agent.auth_env]) {
    console.log(c.yellow(`\n${agent.auth_env} isn't set in this shell.`));
    if (await confirm(rl, "Enter the key now instead? It's used once to register with OpenClaw and never saved to a file.", { defaultYes: true })) {
      apiKey = await askSecret(rl, c.bold(`${agent.auth_env}: `));
    }
  }

  const written = saveAgents({ ...agents, [name]: agent });
  const saved = written[name];
  console.log(c.green(`\n✓ Saved agent "${name}": ${describeAgentLabel(saved)}.`));

  console.log(`\n${c.bold("→")} Registering the key with OpenClaw`);
  const registered = registerProviderWithOpenClaw({ ...apiAgentAsPoolEntry(name, saved), apiKeyOverride: apiKey });
  if (registered && saved.model) {
    console.log(`\n${c.bold("→")} Test call`);
    const provId = saved.provider === "openclaw" ? saved.openclaw_provider : ["bedrock", "azure-openai", "openai-compatible"].includes(saved.provider) ? name : saved.provider;
    if (probeWorker(provId, saved.model)) console.log(c.green(`✓ ${provId}/${saved.model} answered a real test prompt.`));
    else console.log(c.yellow(`⚠ A real test prompt to ${provId}/${saved.model} didn't come back. Check the model id with \`openclaw models list --provider ${provId}\`.`));
  }
  // Dispatch only treats an api agent as usable when its auth_env is set
  // in the MCP server's own environment, which comes from its registration
  // (see derivePoolAuthEnvPlaceholders in lib/connect.mjs), so a new api
  // agent needs one reconnect. Every later edit applies without one.
  if (commandExists("claude") && await confirm(rl, `Reconnect the MCP server so it can use "${name}" (needed once for a new api agent)?`, { defaultYes: true })) {
    connectClaude({ nomarmyRoot, run: (cmd, args2, opts = {}) => execFileSync(cmd, args2, { stdio: "ignore", ...opts }), extraEnv: { [saved.auth_env]: "registered" } });
    console.log(c.green("✓ Reconnected.") + c.dim(" Restart your coordinator session once so it picks up the new registration."));
  } else {
    console.log(c.dim(`Run \`nomarmy connect claude\` before dispatching to "${name}".`));
  }
  console.log(c.dim(`Use it with \`nomarmy army assign <role> ${name}\` or agent: "${name}" on a job.`));
}

const OWNER_EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
function validOwnerEmail(email) { return typeof email === "string" && OWNER_EMAIL_RE.test(email); }
function gitUserEmail() {
  const result = spawnHostGitSync(repoDir, ["config", "user.email"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const email = result.status === 0 ? result.stdout.trim() : "";
  return validOwnerEmail(email) ? email : "";
}

const SUBSCRIPTION_AGENT_DEFAULT_NAMES = { claude: "claude", codex: "codex", meta: "muse" };

async function addSubscriptionAgent(rl, agents) {
  console.log(c.dim("Connects ONE person's own subscription. Never pooled, never shared."));
  const vendorKeys = Object.keys(SUBSCRIPTION_VENDORS);
  let vendorKey = argv[3];
  if (!SUBSCRIPTION_VENDORS[vendorKey]) {
    console.log("\n" + c.bold("Which subscription?"));
    vendorKeys.forEach((k, i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${SUBSCRIPTION_VENDORS[k].label}`));
    vendorKey = vendorKeys[await askChoice(rl, vendorKeys.length)];
  }
  const vendor = SUBSCRIPTION_VENDORS[vendorKey];

  // Checked before any login: an api agent on the same OpenClaw provider id
  // would share the one credential slot, and the save would be refused
  // anyway -- don't walk the operator through a browser flow first.
  const clash = Object.entries(agents).find(([, a]) => a.kind === "api" && (a.provider === "openclaw" ? a.openclaw_provider : a.provider) === vendor.provider);
  if (clash) {
    console.log(c.red(`\n✗ Api agent "${clash[0]}" already uses OpenClaw provider "${vendor.provider}", and OpenClaw holds one credential per provider. Remove it first (\`nomarmy agents remove ${clash[0]}\`), or keep using it instead.`));
    return;
  }

  const auth = await ensureVendorAuth(rl, vendorKey);
  if (!auth.ok) { console.log(c.dim("\nStopped; nothing was written.")); process.exitCode = 1; return; }

  console.log(`\n${c.bold("→")} Models`);
  const needsOpenclawLogin = vendor.credential.kind === "openclaw-login";
  let linkedOpenclaw = false;
  if (vendorKey === "codex") {
    linkedOpenclaw = await openclawProviderLogin(vendor, rl);
    if (!linkedOpenclaw) {
      console.log(c.red("✗ Sign-in has no usable auth profile. Retry with `nomarmy agents add subscription codex`."));
      process.exitCode = 1; return;
    }
  }
  let models = catalogModelsFor(vendor.provider);
  if (!models.length && needsOpenclawLogin && !linkedOpenclaw) {
    linkedOpenclaw = await openclawProviderLogin(vendor, rl);
    if (!linkedOpenclaw) { console.log(c.red(`✗ Sign-in failed or was canceled. Retry with \`nomarmy agents add subscription ${vendorKey}\`.`)); process.exitCode = 1; return; }
    models = catalogModelsFor(vendor.provider);
  }
  // Catalog entries can be cached, and a particular model can refuse a
  // working login. Check OpenClaw's auth profile before asking for details.
  if (needsOpenclawLogin && !hasUsableOpenclawAuthProfile(vendor.provider)) {
    if (linkedOpenclaw || !(await openclawProviderLogin(vendor, rl)) || !hasUsableOpenclawAuthProfile(vendor.provider)) {
      console.log(c.red(`✗ Sign-in has no usable auth profile. Retry with \`nomarmy agents add subscription ${vendorKey}\`.`));
      process.exitCode = 1;
      return;
    }
    linkedOpenclaw = true;
  }
  // The agent is the account; the model is only a default. Roles pick
  // their own model (or "auto" for the General to choose per job).
  if (models.length) models.forEach((m, i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${m}`));
  else console.log(c.dim(`OpenClaw isn't listing ${vendor.provider} models yet.`));
  const pick = (await rl.question(c.bold(`Default model, optional${models.length ? " (a number or an id)" : ""}; blank = pick per role: `))).trim();
  const model = /^\d+$/.test(pick) && models.length ? models[Number(pick) - 1] : pick || null;
  if (pick && !model) throw new Error(`Not a valid choice: "${pick}".`);
  // A usable profile is only a fast precondition. The test call is what
  // proves sign-in: an unexpired Codex import can still answer 401.
  const probeModel = model ?? models[0] ?? vendor.defaultModel;

  const ownerDefault = validOwnerEmail(auth.email) ? auth.email : gitUserEmail();
  const owner = await askUntilValid(rl, `Whose subscription is this${ownerDefault ? ` [${ownerDefault}]` : ""}: `, {
    allowEmpty: Boolean(ownerDefault), fallback: ownerDefault, pattern: OWNER_EMAIL_RE,
    invalidMessage: "enter an email address (one @, no spaces).",
  });

  const name = await askAgentName(rl, agents, SUBSCRIPTION_AGENT_DEFAULT_NAMES[vendorKey] ?? vendorKey);
  if (!name) { console.log(c.dim("Stopped; nothing was written.")); return; }

  console.log(`\n${c.bold("→")} Test call`);
  const probed = Boolean(probeModel);
  const works = probed ? probeWorker(vendor.provider, probeModel) : false;
  if (works) console.log(c.green(`✓ ${vendor.provider}/${probeModel} answered a real test prompt.`));
  else if (needsOpenclawLogin && probed && openclawSignInFailure(`${lastProbeFailure ?? ""}\n${lastProbeText}`)) {
    const why = lastProbeFailure ? `: ${lastProbeFailure}` : "";
    console.log(c.red(`✗ Sign-in failed${why}.`));
    console.log(`  fix: ${codexImportRecovery()}`);
    console.log(c.dim("Stopped; nothing was written."));
    process.exitCode = 1;
    return;
  } else {
    console.log(c.yellow(probeModel ? `⚠ The login works, but ${vendor.provider}/${probeModel} didn't answer a real test prompt.` : "⚠ The login works, but no model is available for a test call."));
    console.log(c.dim(`You can retry later with \`nomarmy agents update ${name} --probe\`.`));
    if (!(await confirm(rl, "Save the agent anyway?", { defaultYes: false }))) {
      console.log(c.dim("Stopped; nothing was written."));
      process.exitCode = 1;
      return;
    }
  }
  const written = saveAgents({ ...agents, [name]: { kind: "subscription", provider: vendor.provider, owner, ...(model ? { model } : {}) } });
  savedAgentMessage(name, written);
  console.log(c.dim(`Jobs on it need on_behalf_of: "${owner}".`));
}

async function cmdAgentsAddJson() {
  const agents = fileAgentsOrExit();
  const name = value("name");
  const kind = value("kind") ?? (AGENT_KINDS.includes(argv[2]) ? argv[2] : null);
  if (!name || !kind) throw new Error(`--json requires --name <agent> and --kind <${AGENT_KINDS.join("|")}>, plus that kind's fields (see \`nomarmy help\`).`);
  if (RESERVED_AGENT_NAMES.includes(name)) throw new Error(`"${name}" is a reserved name.`);
  if (kind === "subscription" && value("owner") !== null && !validOwnerEmail(value("owner"))) throw new Error("--owner must be an email address (one @, no spaces).");
  const agent = { kind };
  const num = (flagName) => (value(flagName) !== null ? Number(value(flagName)) : undefined);
  if (kind === "local") {
    agent.slot = value("slot") ?? "coder";
  } else {
    for (const [field, flagName] of [["provider", "provider"], ["model", "model"], ["owner", "owner"], ["auth_env", "auth-env"], ["base_url", "base-url"], ["openclaw_provider", "openclaw-provider"], ["plugin", "plugin"]]) {
      if (value(flagName) !== null) agent[field] = value(flagName);
    }
    for (const [field, flagName] of [["max_concurrent", "max-concurrent"], ["context_window", "context-window"]]) {
      if (num(flagName) !== undefined) agent[field] = num(flagName);
    }
    const thinking = resolveThinkingFlag();
    if (thinking !== undefined) agent.thinking = thinking;
  }
  if (kind === "subscription" && agent.provider === "openai" && (flag("link-openclaw") || flag("remove-email-profiles"))) {
    if (!readLoginStatus("codex").loggedIn) throw new Error("Confirm Codex CLI login first: codex login");
    const linked = await linkCodex({ run: runQuiet, command: openclawCmd(),
      importLogin: flag("link-openclaw"), removeEmailProfiles: flag("remove-email-profiles"), print: (message) => console.error(message) });
    if (!linked) throw new Error("Codex import failed; nothing was written.");
    if (!probeWorker("openai", agent.model ?? SUBSCRIPTION_VENDORS.codex.defaultModel)) {
      throw new Error(`Codex test call failed; nothing was written. Fix: ${codexImportRecovery()}`);
    }
  }
  const written = saveAgents({ ...agents, [name]: agent });
  const saved = written[name];
  let registered = null, mcpUpdated = false;
  if (kind === "api" && flag("register")) registered = registerProviderWithOpenClaw(apiAgentAsPoolEntry(name, saved));
  if (kind === "api" && flag("update-mcp")) {
    connectClaude({ nomarmyRoot, run: (cmd, args2, opts = {}) => execFileSync(cmd, args2, { stdio: "ignore", ...opts }), extraEnv: { [saved.auth_env]: "registered" } });
    mcpUpdated = true;
  }
  return out({ written: agentsConfigPath(globalConfigDir()), name, agent: saved, ...(kind === "api" ? { registered, mcpUpdated } : {}) });
}

// A probe-only update checks credentials without changing agents.yml.
function probeConfiguredAgent(name, agent) {
  const provider = agentProviderId(agent);
  let model = agent.model;
  let source = "";
  if (!model && provider) {
    const role = agentAssignments()[name]?.roles.find((r) => r.model && r.model !== "auto");
    if (role) { model = role.model; source = `${role.role}'s model`; }
    if (!model) {
      const vendor = Object.values(SUBSCRIPTION_VENDORS).find((v) => v.provider === provider);
      if (vendor?.defaultModel) { model = vendor.defaultModel; source = "vendor default"; }
    }
    if (!model) {
      model = catalogModelsFor(provider)[0];
      if (model) source = "first catalog model";
    }
  }
  if (!provider || !model) {
    console.log(c.red(`✗ ${name}  ${provider ?? agent.kind}/${model ?? "no model"}  no model available; set one with \`nomarmy agents update ${name} --model <m>\``));
    process.exitCode = 1;
    return;
  }
  const selected = `${provider}/${model}${source ? ` (${source})` : ""}`;
  const start = performance.now();
  const ok = probeWorker(provider, model);
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(ok ? c.green(`✓ ${name}  ${selected}  answered in ${elapsed}s`)
    : c.red(`✗ ${name}  ${selected}  failed: ${lastProbeFailure ?? "no answer"}`));
  if (!ok) process.exitCode = 1;
}

function cmdAgentsProbeAll() {
  const agents = fileAgentsOrExit();
  if (!Object.keys(agents).length) { console.log("No configured agents to probe."); return; }
  for (const [name, agent] of Object.entries(agents)) probeConfiguredAgent(name, agent);
}

// --- update ---

// Kind, provider and owner are fixed: changing any of them is a different
// agent (a different model family, vendor, or person's login), so that's
// `agents add`, not an edit. A subscription model change gets the same real
// test call `add` makes (interactive always; --json only with --probe,
// since it spends a real request on the subscription).
async function cmdAgentsUpdate() {
  const name = argv[2]?.startsWith("--") ? null : argv[2];
  if (!name && flag("probe")) return cmdAgentsProbeAll();
  if (!name) throw new Error("Usage: nomarmy agents update <name> [--model <m>|--no-model] [--slot coder|gpt] [--auth-env <NAME>] [--base-url <url>] [--max-concurrent <n>] [--context-window <tokens>] [--thinking [low|medium|high]|--no-thinking] [--probe]");
  const agents = fileAgentsOrExit();
  const current = Object.prototype.hasOwnProperty.call(agents, name) ? agents[name] : name === "local" ? { ...BUILTIN_LOCAL_AGENT } : undefined;
  if (!current) throw new Error(`Unknown agent "${name}". Your agents: ${Object.keys(loadAgentsOrExit().agents).join(", ")}`);

  const changes = {};
  let probe = false;
  // Flags alone are enough; without any, it asks field by field.
  const flagged = ["model", "no-model", "slot", "auth-env", "base-url", "max-concurrent", "context-window", "thinking", "no-thinking", "probe"].some((f) => flag(f));
  if (json || flagged) {
    const num = (flagName) => (value(flagName) !== null ? Number(value(flagName)) : undefined);
    if (value("model") !== null) changes.model = value("model");
    // Back to no default model: every role (or job) then names its own.
    if (flag("no-model")) { if (value("model") !== null) throw new Error("Pass --model or --no-model, not both."); changes.model = undefined; }
    if (value("slot") !== null) changes.slot = value("slot");
    if (value("auth-env") !== null) changes.auth_env = value("auth-env");
    if (value("base-url") !== null) changes.base_url = value("base-url");
    if (num("max-concurrent") !== undefined) changes.max_concurrent = num("max-concurrent");
    if (num("context-window") !== undefined) changes.context_window = num("context-window");
    const thinking = resolveThinkingFlag();
    if (thinking !== undefined) changes.thinking = thinking;
    if (flag("owner") || value("owner") !== null || value("provider") !== null || value("kind") !== null) {
      throw new Error("Kind, provider and owner can't be changed -- that's a different agent. Use `nomarmy agents add`.");
    }
    probe = flag("probe");
    if (!Object.keys(changes).length && !probe) throw new Error("Nothing to update -- pass at least one field flag (see `nomarmy agents update` usage).");
  } else {
    if (!process.stdin.isTTY) throw new Error("nomarmy agents update needs an interactive terminal, or the flags to change (e.g. --max-concurrent 3).");
    const rl = createInterface({ input, output });
    try {
      console.log(c.bold("🍪 nomArmy agents update") + c.dim(`  (${name}: ${describeAgentLabel(current)})`));
      console.log(c.dim("Blank keeps the current value.\n"));
      if (current.kind === "local") {
        const slot = (await rl.question(c.bold(`Slot, coder or gpt [${current.slot}]: `))).trim();
        if (slot && slot !== current.slot) changes.slot = slot;
      } else {
        const provId = current.kind === "subscription" ? current.provider : current.provider === "openclaw" ? current.openclaw_provider : current.provider;
        const models = catalogModelsFor(provId);
        if (models.length) models.forEach((m, i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${m}${m === current.model ? c.dim("  (current)") : ""}`));
        const pick = (await rl.question(c.bold(`Default model${models.length ? " -- a number, or type an id" : ""} [${current.model ?? "none: each role picks"}] ("-" clears it): `))).trim();
        if (pick === "-") { if (current.model) changes.model = undefined; }
        else {
          const chosen = /^\d+$/.test(pick) && models.length ? models[Number(pick) - 1] : pick;
          if (pick && !chosen) throw new Error(`Not a valid choice: "${pick}".`);
          if (chosen && chosen !== current.model) changes.model = chosen;
        }
        if (current.kind === "api") {
          const env = await askUntilValid(rl, `API key environment variable NAME [${current.auth_env}]: `, {
            allowEmpty: true, fallback: current.auth_env, pattern: AUTH_ENV_NAME_RE, invalidMessage: "must look like an ENVIRONMENT VARIABLE NAME, not the key itself.",
          });
          if (env !== current.auth_env) changes.auth_env = env;
        }
        const mc = (await rl.question(c.bold(`max_concurrent [${current.max_concurrent}]: `))).trim();
        if (mc) changes.max_concurrent = Number(mc);
        const label = current.thinking === false ? "off" : current.thinking === true ? "on, follows the job" : `fixed at "${current.thinking}"`;
        const thinking = parseThinkingAnswer(await rl.question(c.bold(`Thinking: y = follow the job, n = off, or low/medium/high [current: ${label}]: `)), current.thinking);
        if (thinking !== current.thinking) changes.thinking = thinking;
        if (changes.model && current.kind === "subscription") {
          console.log(`\n${c.bold("→")} Test call`);
          if (probeWorker(current.provider, changes.model)) console.log(c.green(`✓ ${current.provider}/${changes.model} answered a real test prompt.`));
          else {
            console.log(c.red(`✗ A real test prompt to ${current.provider}/${changes.model} didn't come back.`));
            if (!(await confirm(rl, "Save the change anyway?", { defaultYes: false }))) { console.log(c.dim("Stopped; nothing was written.")); return; }
          }
        }
      }
    } finally {
      rl.close();
    }
    if (!Object.keys(changes).length) { console.log(c.dim("\nNothing changed.")); return; }
  }

  if (probe && !Object.keys(changes).length) { probeConfiguredAgent(name, current); return; }
  if (probe && changes.model && !probeWorker(agentProviderId(current), changes.model)) {
    out({ error: `a real test prompt to ${current.provider}/${changes.model} didn't come back -- nothing was written` });
    process.exit(1);
  }
  const next = { ...current, ...changes };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  const written = saveAgents({ ...agents, [name]: next });
  if (json) return out({ updated: true, name, agent: written[name], changed: Object.keys(changes) });
  console.log(c.green(`\n✓ Updated "${name}": ${describeAgentLabel(written[name])}.`));
  if (changes.auth_env) console.log(c.yellow(`The key's variable changed to ${changes.auth_env}: run \`nomarmy connect claude\` so the MCP server sees it.`));
  else console.log(c.dim("Applies to the next job, no restart."));
}

async function cmdAgents() {
  const sub = argv[1] ?? "list";
  if (sub === "list") return cmdAgentsList();
  if (sub === "add") return cmdAgentsAdd();
  if (sub === "update") return cmdAgentsUpdate();
  if (sub === "remove") return cmdAgentsRemove();
  throw new Error(`Unknown agents subcommand "${sub}". Use: nomarmy agents <list|add|update|remove>`);
}

function git(args) {
  try { return execHostGitSync(nomarmyRoot, args, { cwd: nomarmyRoot, encoding: "utf8" }).trim(); }
  catch (error) { throw new Error(`git ${args.join(" ")} failed: ${error.stderr ? String(error.stderr).trim() : error.message}`); }
}

/**
 * `nomarmy update`: pull and apply the latest nomArmy code -- NOT a model
 * swap, see `nomarmy model` for that. Real motivation: the MCP server Claude
 * Code actually runs is a COPY (installMcpCopy, in lib/connect.mjs, copies
 * mcp/server.mjs + lib/ + package.json into
 * ~/.local/share/nomarmy-local-worker and registers that path), not this
 * checkout -- a bare `git pull` here changes nothing Claude Code is running
 * until that copy step reruns.
 */
async function cmdUpdate() {
  const say = (s) => { if (!json) console.log(s); };
  // Installed from npm: npm updates the package, then connect resyncs the
  // copy each coordinator runs.
  if (!fs.existsSync(path.join(nomarmyRoot, ".git"))) return updateFromNpm();
  const status = git(["status", "--porcelain"]);
  if (status) {
    if (json) { out({ error: "working tree is not clean; refusing to pull over local changes", status }); process.exit(1); }
    console.log(c.red("Working tree is not clean -- refusing to pull over local changes:"));
    console.log(status);
    process.exit(1);
  }

  git(["fetch"]);
  const local = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "@{u}"]);
  const base = git(["merge-base", "HEAD", "@{u}"]);
  if (local === remote) {
    // Nothing to pull, but the copy coordinators run can still be behind
    // this checkout (commits made or pulled here without a reconnect).
    if (!copyIsStale(defaultInstallDir(), nomarmyRoot)) {
      if (json) return out({ updated: false, reason: "already up to date" });
      console.log(c.green("✓ Already up to date, and your coordinators run this checkout."));
      printSessionRestarts({ quietWhenNone: true });
      return;
    }
    say(c.bold("🍪 nomArmy update\n"));
    say("Nothing to pull, but your coordinators run an older copy of this checkout.");
    const resynced = reconnectCoordinators();
    if (json) return out({ updated: false, resynced, sha: local });
    printSessionRestarts();
    return;
  }
  if (base !== local) {
    if (json) { out({ error: "local branch has diverged from upstream; not a clean fast-forward", local, remote, base }); process.exit(1); }
    console.log(c.red("Local branch has diverged from upstream -- not a clean fast-forward. Resolve by hand (rebase or merge), then rerun.")); process.exit(1);
  }

  say(c.bold("🍪 nomArmy update\n"));
  say("Pulling...");
  git(["merge", "--ff-only", "@{u}"]);
  say(c.green(`✓ Pulled to ${git(["rev-parse", "--short", "HEAD"])}.`));

  say("\nInstalling dependencies...");
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: nomarmyRoot, stdio: json ? "ignore" : "inherit" });

  const resynced = reconnectCoordinators();

  if (json) return out({ updated: true, sha: git(["rev-parse", "HEAD"]), resynced });
  console.log(c.yellow("\nThe MCP server is a per-session child process: every open Claude Code / Codex / Cursor session needs a restart to pick this up, not just this one."));
}

// The coordinators nomArmy is registered with. Cursor has no CLI to probe,
// so it counts when its own config already lists nomArmy.
// Reconnect every connected coordinator through a child process, so it runs
// the code now on disk (just pulled or installed) rather than the old code
// this process loaded. Returns the targets reconnected.
// Each open session keeps the nomArmy it started with: name the ones that
// started before the installed copy, rather than a blanket "restart".
function printSessionRestarts({ quietWhenNone = false } = {}) {
  let list = null;
  try {
    const installedAt = fs.statSync(path.join(defaultInstallDir(), "source.json")).mtimeMs;
    const procs = listProcesses();
    if (procs) list = staleSessions(procs, { installedAt });
  } catch { /* no installed copy yet, or ps unavailable */ }
  if (list === null) {
    if (!quietWhenNone) console.log(c.yellow("\nRestart every open Claude Code, Codex and Cursor session: each keeps the code it started with until then."));
    return;
  }
  if (!list.length) { if (!quietWhenNone) console.log(c.green("\n✓ No open session runs an older nomArmy.")); return; }
  console.log(c.yellow(`\n${list.length} open session(s) still run an older nomArmy, until each is restarted:`));
  for (const line of formatStaleSessions(list)) console.log(line);
  console.log(c.dim("In Claude Code: /exit, then claude --resume (or /mcp → nomarmy-local-worker → Reconnect). Close any you no longer use."));
}

function reconnectCoordinators() {
  const targets = connectedTargets();
  // Per-repo registrations run the installed copy (or `nomarmy mcp`), so a
  // refreshed copy is all they need; re-registering them at user scope would
  // add nomArmy to every project.
  if (!targets.length) {
    execFileSync(process.execPath, [path.join(nomarmyRoot, "bin", "nomarmy.mjs"), "connect", "--copy-only", ...(json ? ["--json"] : [])], { stdio: json ? "ignore" : "inherit" });
    return [];
  }
  if (targets.length) {
    if (!json) console.log(`\nReconnecting ${targets.join(", ")}...`);
    execFileSync(process.execPath, [path.join(nomarmyRoot, "bin", "nomarmy.mjs"), "connect", ...targets, ...(json ? ["--json"] : [])], { stdio: json ? "ignore" : "inherit" });
  }
  return targets;
}

function connectedTargets() {
  return [commandExists("claude") && claudeUserScoped() && "claude", commandExists("codex") && "codex", cursorAlreadyConnected() && "cursor"].filter(Boolean);
}

async function updateFromNpm() {
  const current = readPackageVersion(nomarmyRoot);
  let latest = null;
  try { latest = execFileSync("npm", ["view", "nomarmy", "dist-tags.alpha"], { encoding: "utf8", timeout: 20000 }).trim(); } catch { /* offline */ }
  if (!latest) {
    const fix = "npm install -g nomarmy@alpha && nomarmy connect claude";
    if (json) { out({ error: "could not read nomarmy's latest release from npm", fix }); process.exit(1); }
    console.log(c.red("Couldn't reach npm to find nomArmy's latest release.") + ` Update by hand:\n  ${fix}`);
    process.exit(1);
  }
  const { copyVersion } = readInstallVersions(defaultInstallDir());
  const upgrade = compareVersions(current, latest) < 0;
  const staleCopy = !copyVersion || compareVersions(copyVersion, upgrade ? latest : current) < 0;
  if (!upgrade && !staleCopy) {
    if (json) return out({ updated: false, version: current, reason: "already up to date" });
    console.log(c.green(`✓ nomArmy ${current} is the latest, and your coordinators run it.`));
    return;
  }
  if (upgrade) {
    if (!json) console.log(c.bold(`🍪 Updating nomArmy ${current} → ${latest}\n`));
    execFileSync("npm", ["install", "-g", `nomarmy@${latest}`, "--no-audit", "--no-fund"], { stdio: json ? "ignore" : "inherit" });
  }
  const targets = reconnectCoordinators();
  if (json) return out({ updated: upgrade, from: current, version: upgrade ? latest : current, resynced: targets });
  printSessionRestarts();
}

function commandExists(cmd) {
  try { execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }); return true; }
  catch { return false; }
}

/** A dependency-free multi-select: numbered checklist, comma-separated
 * answer, matching the plain-readline style already used elsewhere in this
 * CLI (setup's numbered "Choice [1]:" prompts) rather than pulling in an
 * arrow-key TUI library for one prompt. */
async function promptMultiSelect(options, question) {
  const rl = createInterface({ input, output });
  try {
    console.log(c.bold(question));
    options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
    const answer = (await rl.question(c.bold('Choice(s) [comma-separated numbers, or "all"]: '))).trim().toLowerCase();
    if (!answer) return [];
    if (answer === "all") return [...options];
    const picked = new Set();
    for (const token of answer.split(",").map((s) => s.trim()).filter(Boolean)) {
      const idx = Number(token);
      if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) picked.add(options[idx - 1]);
    }
    return [...picked];
  } finally {
    rl.close();
  }
}

/**
 * `nomarmy connect [claude] [codex] [cursor]`: (re-)register the MCP server
 * with one or more coordinators on its own, without a full `update`. Useful
 * standalone -- e.g. a coordinator installed *after* nomArmy already was --
 * not only as an update step. With no target named and not --json, prompts
 * an interactive multi-select instead of requiring one call per target.
 */
async function cmdConnect() {
  // Positional, but never a fixed argv index: every other command in this
  // CLI is position-independent with respect to global flags (flag()/value()
  // scan the whole argv), and `nomarmy connect --json claude` once broke
  // that promise by reading argv[1] directly -- --json landed in target's
  // slot instead. Multiple bare tokens are now allowed too, for multi-select.
  const flagValues = new Set(["--scope", "--repo"].map((name) => argv.indexOf(name)).filter((i) => i >= 0).map((i) => i + 1));
  const requested = argv.slice(1).filter((a, i) => !a.startsWith("--") && !flagValues.has(i + 1));
  const scope = value("scope", "user");
  if (!SCOPES.includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join(", ")}, got "${scope}".`);
  const nativeWindows = windowsFrontEnd();
  if (nativeWindows && scope !== "user") throw new Error("per-repo registration on Windows isn't supported yet; use the default --scope user");
  if (nativeWindows && flag("copy-only")) throw new Error("Windows runs nomArmy inside WSL; run nomarmy connect <target> instead of --copy-only");
  let projectDir = null;
  if (scope !== "user") {
    try { projectDir = execHostGitSync(repoDir, ["rev-parse", "--show-toplevel"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { throw new Error(`--scope ${scope} registers nomArmy for one repository, and ${repoDir} isn't inside a git repository. Run it from the repository (or pass --repo <dir>).`); }
  }
  if (flag("copy-only")) {
    // `nomarmy update` with only per-repo registrations: refresh the copy they run.
    installMcpCopy({ nomarmyRoot, installDir: defaultInstallDir(), run: (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: json ? "ignore" : "inherit", ...opts }) });
    return json ? out({ refreshed: defaultInstallDir() }) : console.log(c.green(`✓ Refreshed the nomArmy copy in ${defaultInstallDir()}.`));
  }
  let targets;
  if (requested.length > 0) {
    const unknown = requested.filter((t) => !KNOWN_TARGETS.includes(t));
    if (unknown.length) throw new Error(`unknown target(s) ${unknown.join(", ")}. Known: ${KNOWN_TARGETS.join(", ")}.`);
    targets = [...new Set(requested)];
  } else if (json) {
    throw new Error(`nomarmy connect --json needs at least one target: ${KNOWN_TARGETS.join(", ")}.`);
  } else {
    targets = await promptMultiSelect(KNOWN_TARGETS, "🍪 Which coordinator(s) should nomArmy register with?");
    if (targets.length === 0) { console.log("Nothing selected."); return; }
  }

  const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: json ? "ignore" : "inherit", ...opts });
  const results = [];
  for (const target of targets) {
    // Cursor is a JSON file, not a CLI on PATH -- nothing to probe there.
    if (target !== "cursor" && !commandExists(target)) {
      const error = `${target} was not found on PATH.`;
      results.push({ target, connected: false, error });
      if (!json) console.log(c.red(`✗ ${target}: ${error}`));
      continue;
    }
    try {
      if (!json) console.log(c.bold(`\n🍪 Connecting nomArmy to ${target}...`));
      if (nativeWindows) {
        const capture = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
        const distro = pickDistro({ run: capture });
        const resolved = resolveWslNomarmy({ distro, run: capture });
        const launch = mcpBridgeLaunch({ distro, ...resolved });
        const result = connectViaWsl({ target, distro, launch, run, nomarmyRoot });
        writeWindowsSettings({ distro, ...resolved });
        results.push({ target, connected: true, ...result });
        if (!json) console.log(c.green(`✓ Registered nomArmy with ${target}, running inside WSL (${distro})`));
        continue;
      }
      const result = connectTarget(target, { nomarmyRoot, run, scope, projectDir });
      results.push({ target, connected: true, ...result });
      if (!json) console.log(c.green(`✓ Registered nomarmy-local-worker with ${target}${scope === "user" ? "." : scope === "local" ? ` for ${projectDir} only (not committed).` : ` in ${path.relative(projectDir, result.configPath ?? path.join(projectDir, ".mcp.json"))}, for everyone who clones this repository.`}`));
      if (!json && scope === "local" && result?.excluded?.length) console.log(c.dim(`  Kept out of git (.git/info/exclude): ${result.excluded.join(", ")}`));
      if (!json && scope === "project") console.log(c.dim(`  Commit it along with the playbook in ${path.relative(projectDir, result.commands.dir)}. Each teammate needs nomArmy installed and set up (npm install -g nomarmy@alpha, then nomarmy setup); the registration runs \`nomarmy mcp\`, which uses their own settings.`));
      if (!json && scope !== "user" && target === "claude" && result?.userScoped) console.log(c.yellow(`  nomArmy is also registered for all your projects (user scope). To use it only where you register it per repository: claude mcp remove nomarmy-local-worker -s user`));
      if (!json && result?.commands?.installed?.length) console.log(c.green(`✓ Playbooks: ${result.commands.installed.join(", ")}`) + c.dim(` in ${result.commands.dir} (restart ${target} to pick up a new one)`));
      if (!json && result?.notifier?.status === "built") console.log(c.green("✓ Notifications: nomArmy.app, with nomArmy's icon") + c.dim(" (macOS asks once whether to allow it)"));
      if (!json && result?.notifier?.status === "failed") console.log(c.yellow(`⚠ Couldn't build nomArmy.app (${result.notifier.reason}); notifications still work, with Script Editor's icon. Xcode's command-line tools provide swiftc: xcode-select --install`));
      if (!json && result?.statusLine === "installed") console.log(c.green("✓ Claude Code status line: nomArmy's") + c.dim(" (shows running jobs and the active run; restart Claude Code to see it)"));
      if (!json && result?.statusLine === "kept-yours") console.log(c.dim("Kept your own Claude Code status line. To add nomArmy's to it, have your command also run `nomarmy statusline`."));
      if (!json && result?.commands?.skipped?.length) console.log(c.yellow(`⚠ Left your own ${result.commands.skipped.join(", ")} in ${result.commands.dir} alone (not nomArmy's); nomArmy's version is in playbooks/.`));
    } catch (error) {
      results.push({ target, connected: false, error: error.message });
      if (!json) console.log(c.red(`✗ ${target}: ${error.message}`));
    }
  }

  const failed = results.filter((r) => !r.connected);
  if (failed.length) process.exitCode = 1;
  if (json) return out({ results });
}

/** Thin, mechanical wrappers around already-working scripts -- unlike connect's port to JS, these are real bash process/PID management with no awkward Node-calling-Node seam to fix, so spawning them is the right amount of wrapping, not under- or over-engineering it. */
function runScript(name, args = []) {
  execFileSync("bash", [path.join(nomarmyRoot, "scripts", name), ...args], { cwd: nomarmyRoot, stdio: "inherit" });
}
// `nomarmy sandbox`: see lib/sandbox-vm.mjs.
async function cmdSandbox() {
  const stateRoot = process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents");
  const podman = (args, opts = {}) => spawnSync("podman", args, { encoding: "utf8", ...opts });
  const machine = process.platform === "linux" ? null : pickMachine(podman(["machine", "inspect"]).stdout);
  let images = null;
  try {
    const rows = JSON.parse(podman(["system", "df", "--format", "json"]).stdout || "[]");
    const row = rows.find((r) => /image/i.test(r.Type ?? ""));
    if (row) images = { count: row.Total ?? null, size: row.Size ?? null, reclaimable: row.Reclaimable ?? null };
  } catch { /* podman missing or old */ }
  const runningJobs = liveLeases(path.join(stateRoot, "leases")).length;
  const memoryGib = value("memory");

  if (!memoryGib && !flag("prune") && !flag("repair")) {
    if (json) return out({ platform: process.platform, machine, images, runningJobs, minimumMb: MIN_PODMAN_VM_MB });
    console.log(c.bold("🍪 nomArmy sandbox"));
    if (process.platform === "linux") console.log("\nPodman runs natively on Linux: there's no VM to size.");
    else if (!machine) console.log(c.yellow("\nNo Podman machine found. Run: podman machine init && podman machine start"));
    else {
      const low = machine.memoryMb && machine.memoryMb < MIN_PODMAN_VM_MB;
      console.log(`\nVM ${machine.name} (${machine.state}): ${machine.cpus} CPUs, ${low ? c.red(`${machine.memoryMb / 1024} GiB memory`) : `${machine.memoryMb / 1024} GiB memory`}, ${machine.diskGb} GB disk`);
      if (low) console.log(c.yellow(`  Too small: worker commands get cut off below ${MIN_PODMAN_VM_MB / 1024} GiB. Fix: nomarmy sandbox --memory 8`));
      const { maxJobs, jobsThatFit, vmGibFor } = await import("../lib/limits.mjs");
      const limit = maxJobs().value, fit = jobsThatFit(machine.memoryMb);
      if (fit !== null) console.log(limit > fit
        ? c.yellow(`  Fits about ${fit} sandboxes at once, but up to ${limit} api and subscription jobs may run. Fix: nomarmy sandbox --memory ${vmGibFor(limit)}, or nomarmy config max-jobs ${fit}`)
        : c.dim(`  Fits about ${fit} sandboxes at once; up to ${limit} api and subscription jobs may run (nomarmy config max-jobs).`));
    }
    if (images) console.log(`Images: ${images.count}, ${images.size}${images.reclaimable ? `, ${images.reclaimable} reclaimable (nomarmy sandbox --prune)` : ""}`);
    console.log(c.dim(runningJobs ? `${runningJobs} nomArmy job(s) running.` : "No nomArmy jobs running."));
    return;
  }

  const ask = async (question) => {
    if (flag("yes")) return true;
    if (!process.stdin.isTTY) throw new Error(`${question} Re-run with --yes to confirm without a terminal.`);
    const rl = createInterface({ input, output });
    try { return await confirm(rl, question, { defaultYes: false }); } finally { rl.close(); }
  };
  const runPodman = (args) => {
    console.log(c.dim(`$ podman ${args.join(" ")}`));
    const r = podman(args, { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`podman ${args.join(" ")} failed (exit ${r.status ?? "none"}).`);
  };

  if (flag("repair")) {
    // Restore the subordinate ID ranges a Podman machine ships with, only
    // where they're missing, then let Podman re-read them.
    if (process.platform === "linux") throw new Error("On Linux, add a range for your user to /etc/subuid and /etc/subgid (e.g. `sudo usermod --add-subuids 100000-1099999 --add-subgids 100000-1099999 $USER`), then run `podman system migrate`.");
    if (!machine) throw new Error("No Podman machine found. Run: podman machine init && podman machine start");
    // podman system migrate stops every container, a running job's sandbox included.
    if (runningJobs > 0) throw new Error(`${runningJobs} nomArmy job(s) are running; the repair restarts Podman's containers and would kill their sandboxes. Run it when they're done.`);
    const script = 'set -e; restored=0; for f in /etc/subuid /etc/subgid; do if ! grep -q "^$(id -un):" "$f" 2>/dev/null; then echo "$(id -un):100000:1000000" | sudo tee -a "$f" >/dev/null; echo "restored $f"; restored=1; else echo "$f already has a range"; fi; done; if [ "$restored" = 1 ]; then podman system migrate; else echo "nothing to repair"; fi';
    if (!(await ask(`Restore missing subordinate ID ranges in the ${machine.name} VM and run podman system migrate?`))) { console.log(c.dim("Nothing changed.")); return; }
    const r = spawnSync("podman", ["machine", "ssh", machine.name, script], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`the repair failed (exit ${r.status ?? "none"}).`);
    console.log(c.green("✓ Done. Check with: nomarmy doctor"));
    return;
  }

  if (memoryGib) {
    const plan = planResize({ gib: memoryGib, machine, hostMemoryMb: os.totalmem() / 1024 / 1024, runningJobs });
    if (!plan.ok) throw new Error(plan.problems.join("; "));
    for (const w of plan.warnings) console.log(c.yellow(`⚠ ${w}`));
    if (!(await ask(`Restart the Podman VM with ${memoryGib} GiB (from ${machine.memoryMb / 1024})?`))) { console.log(c.dim("Nothing changed.")); return; }
    for (const args of plan.commands) runPodman(args);
    console.log(c.green(`✓ The Podman VM now has ${memoryGib} GiB.`));
  }
  if (flag("prune")) {
    if (runningJobs > 0) throw new Error(`${runningJobs} nomArmy job(s) are running; prune when they're done.`);
    if (!(await ask(`Remove every image no container uses${images?.reclaimable ? ` (about ${images.reclaimable})` : ""}? nomArmy rebuilds its own when a job needs them.`))) { console.log(c.dim("Nothing removed.")); return; }
    runPodman(["image", "prune", "--all", "--force"]);
  }
}

async function cmdStart() { console.log(c.bold("🍪 Starting inference...\n")); runScript("start-inference.sh", argv.slice(1)); }
async function cmdStop() { runScript("stop-inference.sh", argv.slice(1)); }
function safeDu(dir) {
  try { return execFileSync("du", ["-sh", dir], { encoding: "utf8" }).trim().split(/\s+/)[0]; }
  catch { return "unknown size"; }
}

/** The llama.cpp build + job/log records live here, separate from the small
 * MCP install dir uninstall.sh already removes -- see install-llama-cpp.sh
 * and start-inference.sh, which both default to this same path. */
function agentsDirDefault() {
  return process.env.NOMARMY_INSTALL_ROOT
    || path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".local", "share", "nomarmy-local-agents");
}

async function confirmDestructive(question, force) {
  if (force) return true;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(c.bold(question))).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function maybeRemoveAgentsDir({ force }) {
  const dir = agentsDirDefault();
  if (!fs.existsSync(dir)) return null;
  const size = safeDu(dir);
  const ok = await confirmDestructive(
    `\nAlso remove ${dir} (${size}) -- job records, logs, and the built llama.cpp binary? A fresh install will need to rebuild it. [y/N] `,
    force,
  );
  if (!ok) { console.log("  Skipped -- left in place."); return false; }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(c.green(`  Removed ${dir} (${size}).`));
  return true;
}

/** Only the repo(s) nomArmy's OWN config declares -- never a blanket sweep
 * of ~/.cache/huggingface/hub, which is shared with any other tool using
 * huggingface_hub's standard cache. A model tested via a one-off
 * NOMARMY_MODEL_REPO override (never written to config/common.env, the way
 * most of tonight's model comparisons were run) is not tracked here and
 * needs manual cleanup -- an honest, bounded scope beats guessing at which
 * cache entries are "ours". */
function resolveConfiguredModelRepos() {
  const repo = setting("NOMARMY_MODEL_REPO");
  return repo ? [repo] : [];
}

function hfCacheDirFor(repo) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".cache", "huggingface", "hub", `models--${repo.replace(/\//g, "--")}`);
}

async function maybeRemoveModelCaches({ force }) {
  const removed = [];
  for (const repo of resolveConfiguredModelRepos()) {
    const dir = hfCacheDirFor(repo);
    if (!fs.existsSync(dir)) continue;
    const size = safeDu(dir);
    const ok = await confirmDestructive(`Also remove cached model ${repo} (${size}) from ~/.cache/huggingface/hub? [y/N] `, force);
    if (!ok) { console.log(`  Skipped ${repo} -- left in place.`); continue; }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(c.green(`  Removed cached model ${repo} (${size}).`));
    removed.push(repo);
  }
  if (!removed.length) {
    console.log("  No configured model repo found cached locally, or it was skipped above. Note: models tested via a manual NOMARMY_MODEL_REPO override, never saved to config/common.env, are not tracked here and need manual cleanup.");
  }
  return removed;
}

async function cmdUninstall() {
  const clearModels = flag("clear-models") || flag("all");
  const clearAgents = flag("clear-agents") || flag("all");
  const force = flag("force");

  if ((clearModels || clearAgents) && json && !force) {
    throw new Error("--clear-models/--clear-agents with --json needs --force -- these delete real, possibly multi-GB local state, and nothing is removed without explicit confirmation.");
  }

  if (!json) console.log(c.yellow("Removing the nomArmy local worker MCP installation...\n"));
  runScript("uninstall.sh");

  const result = { uninstalled: true, agentsRemoved: null, modelsRemoved: [] };
  if (clearAgents) result.agentsRemoved = await maybeRemoveAgentsDir({ force });
  if (clearModels) result.modelsRemoved = await maybeRemoveModelCaches({ force });

  if (json) return out(result);
  console.log(c.green("\n✓ Removed."));
  if (!clearAgents) console.log("  Job records, logs, and the built llama.cpp binary under ~/.local/share/nomarmy-local-agents were kept -- pass --clear-agents to also remove them.");
  if (!clearModels) console.log("  Downloaded model files under ~/.cache/huggingface/hub were kept -- pass --clear-models to also remove the one(s) nomArmy's config references.");
}

async function cmdSizing() {
  const execution = value("execution", process.env.NOMARMY_EXECUTION || "local");
  const hardware = await detectHardware();
  const modelPath = findModel();
  const gguf = modelPath ? await readGGUFMetadata(modelPath) : { found: false };
  if (gguf.found) gguf.fileSizeBytes = totalSplitBytes(modelPath);

  if (flag("check")) return sizingCheck(hardware, gguf);

  // Optional: if NOMARMY_LLAMA_CACHE_TYPE_K/V are set (quantizing the KV
  // cache to fit more context), reflect that in the estimate instead of
  // silently assuming fp16. Unset by default -- nothing changes for anyone
  // who hasn't touched these.
  const bytesPerKvElement = bytesPerKvElementForCacheTypes(
    process.env.NOMARMY_LLAMA_CACHE_TYPE_K, process.env.NOMARMY_LLAMA_CACHE_TYPE_V);

  // --noms N: size for an EXACT worker count instead of "more noms" (max
  // that fits) or "nominal" (fixed at 1). Bypasses the rest of the report
  // entirely -- scriptable, and works in --json too.
  const nomsFlag = value("noms");
  if (nomsFlag !== null) {
    const noms = Number(nomsFlag);
    if (!Number.isFinite(noms) || noms < 1) throw new Error(`--noms must be a positive number, got "${nomsFlag}".`);
    const custom = customRecommendation({ hardware, gguf, execution, noms, bytesPerKvElement });
    if (json) return out({ hardware, gguf: { found: gguf.found, path: gguf.path ?? null }, recommendation: custom });
    printHardwareAndModel(hardware, gguf);
    printCustomResult(custom);
    return;
  }

  const res = recommend({ hardware, gguf, execution, bytesPerKvElement });
  if (json) {
    return out({ hardware, gguf: { found: gguf.found, path: gguf.path ?? null }, recommendation: res });
  }

  if (res.kind === "cloud") {
    console.log(`Execution is '${execution}' - hosted inference, so local hardware does not bound this.\n`);
    console.log(`  NOMARMY_MAX_WORKERS=${res.maxWorkers}`);
    console.log(`\nBounded by ${res.limitedBy}, not by this machine.`);
    printWarnings(res.warnings);
    return;
  }

  printHardwareAndModel(hardware, gguf);

  // Never present a configuration as "recommended" when the arithmetic says it
  // does not fit. The fallback is a floor to start from, not an endorsement.
  // fits is a tri-state (true/false/null): null means hardware was totally
  // unmeasurable, not that it fits -- `null !== false` must not fall through
  // to the "measured, fits" message, or an unmeasured machine gets the exact
  // same confident framing as a real recommendation.
  const doesNotFit = res.memory && res.memory.fits === false;
  const unmeasured = res.memory && res.memory.fits === null;
  console.log(doesNotFit
    ? `\nNOTHING FITS on this machine. Closest fallback (confidence: ${res.confidence}):\n`
    : unmeasured
    ? `\nHARDWARE COULD NOT BE MEASURED. This is an unverified floor, not a recommendation (confidence: ${res.confidence}):\n`
    : `\nMore noms (confidence: ${res.confidence}) -- as many as fit in memory:\n`);
  for (const [k, v] of Object.entries(res.env ?? {})) console.log(`  ${k}=${v}`);
  console.log(`\n  ${res.maxWorkers} nom(s) at ${K(res.contextPerNom)} each`
    + (res.contextTotal ? `  (${res.contextTotal} total across ${res.llamaParallel} slot(s))` : ""));
  if (res.limitedBy) console.log(`  limited by: ${res.limitedBy}`);

  // "More noms" answers what fits in memory; it has no model of inference
  // speed or worker contention at all. Every profile actually shipped in
  // config/profiles/*.env uses 1-2 workers regardless of how much more
  // would fit -- "nominal" makes that convention explicit rather than
  // leaving it as something you only learn by reading the README's
  // benchmarks. No third "fast" tier: worker count is the only
  // speed-relevant lever this project has real (measured) data for, and it
  // collapses to the same thing as nominal.
  if (res.nominal && !res.nominal.sameAsRecommended) {
    console.log(`\nNominal -- 1 nom, matching this project's own shipped profiles${res.nominal.fits ? "" : " (DOES NOT FIT either -- nothing on this machine does)"}:\n`);
    for (const [k, v] of Object.entries(res.nominal.env)) console.log(`  ${k}=${v}`);
  }

  if (res.alternatives?.length) {
    console.log("\nAlternatives:");
    for (const a of res.alternatives) {
      const label = a.label ?? `${a.maxWorkers} nom(s) @ ${K(a.contextPerNom)}`;
      console.log(`  ${String(label).padEnd(26)}${a.fits === false ? "does not fit" : "fits"}`);
    }
  }
  printWarnings(res.warnings);
  if (res.assumptions?.length) {
    console.log("\nAssumptions:");
    for (const a of res.assumptions) console.log(`  ${a}`);
  }
  // Context bounds text, so show what a nom at this context can be asked and
  // how much it can say back. Memory pressure is checked at job admission by
  // the MCP server, not here.
  const { deriveBudgets, describeBudgets } = await import("../lib/budget.mjs");
  console.log("\nWorker budgets at this context:");
  for (const line of describeBudgets(deriveBudgets({ contextPerNom: res.contextPerNom, source: "this recommendation" }))) console.log(`  ${line}`);
  console.log("\nThis is a recommendation. Apply it by editing config/profiles/<profile>.env.");

  // "More noms"/"nominal" are both already fully printed above; the one
  // thing this command couldn't answer without a re-run was "what about N
  // workers specifically". Skipped entirely for cloud (no local slots to
  // size) and whenever stdin isn't interactive -- readline resolves an
  // unanswerable question with "" on EOF, so this degrades safely under a
  // pipe or in CI rather than hanging.
  if (res.kind === "local") {
    const rl = createInterface({ input, output });
    let answer;
    try {
      answer = (await rl.question(c.bold("\nSize for a specific worker count instead? Enter a number, or press Enter to skip: "))).trim();
    } finally {
      rl.close();
    }
    if (answer) {
      const noms = Number(answer);
      if (!Number.isFinite(noms) || noms < 1) console.log(`Not a positive number: "${answer}". Skipped.`);
      else printCustomResult(customRecommendation({ hardware, gguf, execution, noms, bytesPerKvElement }));
    }
  }
}

function printHardwareAndModel(hardware, gguf) {
  console.log(`Hardware: ${hardware.platform}/${hardware.arch}`
    + `, ${hardware.cpu?.logicalCores ?? "?"} logical cores`
    + `, ${gib(hardware.memory?.totalBytes)} RAM`
    + (hardware.gpu?.count ? `, ${hardware.gpu.count} GPU` : ", no NVIDIA GPU"));
  console.log(`Model: ${gguf.found
    ? `${path.basename(gguf.path)} (${gib(gguf.fileSizeBytes)})`
    : "not found - using assumed architecture"}`);
}

function printCustomResult(res) {
  if (res.kind === "cloud") {
    console.log(`\nCustom -- ${res.requestedNoms} worker(s), hosted execution (no local memory ceiling):\n`);
    for (const [k, v] of Object.entries(res.env)) console.log(`  ${k}=${v}`);
    return;
  }
  if (!res.fits) {
    console.log(`\nCustom -- ${res.requestedNoms} worker(s) DOES NOT FIT on this machine, even at the minimum context (${K(MIN_CONTEXT_PER_NOM)}).`);
    return;
  }
  console.log(`\nCustom -- ${res.requestedNoms} worker(s) as requested`
    + (res.steppedDownFrom ? `, context stepped down from ${K(res.steppedDownFrom)} to fit` : "") + ":\n");
  for (const [k, v] of Object.entries(res.env)) console.log(`  ${k}=${v}`);
  console.log(`\n  ${res.requestedNoms} nom(s) at ${K(res.contextPerNom)} each  (${res.contextTotal} total across ${res.llamaParallel} slot(s))`);
  if (res.limitedBy) console.log(`  limited by: ${res.limitedBy}`);
}

function sizingCheck(hardware, gguf) {
  const contextTotal = Number(process.env.NOMARMY_LLAMA_CONTEXT) || null;
  const llamaParallel = Number(process.env.NOMARMY_LLAMA_PARALLEL) || null;
  const maxWorkers = Number(process.env.NOMARMY_MAX_WORKERS) || null;
  if (!contextTotal || !llamaParallel) {
    console.error("No profile is loaded. Source one first, for example:");
    console.error("  source scripts/lib.sh && load_profile macbook-pro && nomarmy sizing --check");
    process.exit(2);
  }
  const res = evaluateConfig({ hardware, gguf, contextTotal, llamaParallel, maxWorkers });
  if (json) return out(res);
  console.log(`Current profile: ${contextTotal} total context / ${llamaParallel} slot(s) / ${maxWorkers} worker(s)\n`);
  console.log(`  context per nom: ${K(res.contextPerNom)}`);
  printWarnings(res.warnings);
  process.exit((res.warnings ?? []).some((w) => w.severity === "error") ? 1 : 0);
}

// --- `nomarmy army` / `nomarmy config` ------------------------------------
//
// The army layers (see lib/army.mjs) are global config.yml, the repo's
// .nomarmy.yml and its gitignored .nomarmy.local.yml. `--repo` picks the
// repo, same as every other command here; it defaults to the cwd.

function armyLayerFlag(fallback = "global") {
  const chosen = ["global", "project", "local"].filter((l) => flag(l));
  if (chosen.length > 1) throw new Error(`Pick one of --global, --project or --local, not ${chosen.map((l) => `--${l}`).join(" and ")}.`);
  return chosen[0] ?? fallback;
}

function loadArmyForCli({ globalOnly = false, usageRefresh = null } = {}) {
  const agents = loadAgentsOrExit().agents;
  const loaded = globalOnly
    ? (() => {
        const filePath = armyLayerPath("global", { projectDir: repoDir });
        const army = readArmyFile(filePath, { armyOnly: true });
        return { ...mergeArmy([{ layer: "global", army }]), layers: [{ layer: "global", path: filePath, exists: fs.existsSync(filePath), hasArmy: Boolean(army) }] };
      })()
    : loadArmy({ projectDir: repoDir });
  const usageSnapshots = usageRefresh?.snapshots ?? readUsageSnapshots(process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents"));
  return { loaded, agents, summary: describeArmy(loaded, { agents, describeAgent: describeAgentLabel, usageSnapshots, agentProviderId, usageRefreshError: usageRefresh?.error ?? null, usageRefreshFailed: usageRefresh?.failedProviders ?? null }) };
}

// Claude Code adds settings.local.json to .gitignore for the same reason:
// the local layer is personal, and a teammate's checkout must never pick it up.
function ensureLocalLayerIgnored() {
  if (!fs.existsSync(path.join(repoDir, ".git"))) return;
  const ignorePath = path.join(repoDir, ".gitignore");
  const text = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  if (text.split(/\r?\n/).some((line) => line.trim() === LOCAL_CONFIG_FILENAME || line.trim() === `/${LOCAL_CONFIG_FILENAME}`)) return;
  fs.writeFileSync(ignorePath, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${LOCAL_CONFIG_FILENAME}\n`);
  if (!json) console.log(c.dim(`Added ${LOCAL_CONFIG_FILENAME} to .gitignore.`));
}

function agentCell(name, runsOn, role = null) {
  if (!name) return c.yellow("(no agent)");
  const model = role?.modelIsAuto ? "auto (the General picks)" : role?.model;
  return `${name}${model ? ` ${c.bold(model)}` : ""}${runsOn ? c.dim(`  ${runsOn}`) : ""}`;
}

/** An agent's usage-limit reading (lib/usage-limits.mjs), colored by level. */
function usageLine(usage, indent) {
  const text = `${indent}usage: ${usage.text}`;
  return usage.level === "over" ? c.red(`${text} (at the limit)`) : usage.level === "high" ? c.yellow(text) : c.dim(text);
}

function repositoryHere(dir) {
  let current = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function cmdArmyShow() {
  const inRepository = repositoryHere(repoDir);
  const stateRoot = process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents");
  const usageRefresh = await refreshStaleOverLimitReadings(stateRoot);
  const { summary } = loadArmyForCli({ globalOnly: !inRepository, usageRefresh });
  if (json) return out(summary);
  const g = summary.general;
  console.log(c.bold("🪖 nomArmy") + (inRepository ? c.dim(`  (${repoDir})`) : ""));
  if (!inRepository) console.log(c.dim("no repository here: showing global settings"));
  console.log(`\n${c.bold("General")}  ${g.agent ? agentCell(g.agent, g.agentRunsOn) : ""}${g.setBy ? c.dim(`  [${g.setBy}]`) : ""}`);
  console.log(c.dim(`  ${g.who}`));
  for (const line of g.responsibilities) console.log(c.dim(`  - ${line}`));
  if (g.problem) console.log(c.yellow(`  ⚠ ${g.problem}`));
  if (g.usage) console.log(usageLine(g.usage, "  "));
  if (summary.workflow) console.log(`\n${c.bold("Workflow")}\n${summary.workflow.split("\n").map((l) => `  ${l}`).join("\n")}`);
  const names = Object.keys(summary.roles);
  if (!names.length) {
    console.log(c.dim(`\nNo roles yet. ${summary.howToDispatch}`));
  } else {
    const byPhase = new Map();
    for (const name of names) {
      const phase = summary.roles[name].phase ?? "unphased";
      if (!byPhase.has(phase)) byPhase.set(phase, []);
      byPhase.get(phase).push(name);
    }
    for (const phase of [...ARMY_PHASES, "unphased"].filter((p) => byPhase.has(p))) {
      console.log(`\n${c.bold(phase[0].toUpperCase() + phase.slice(1))}`);
      for (const name of byPhase.get(phase)) {
        const role = summary.roles[name];
        console.log(`  ${c.cyan(name.padEnd(18))} ${agentCell(role.agent, role.agentRunsOn, role)}${role.setBy.agent ? c.dim(`  [${role.setBy.agent}]`) : ""}`);
        if (role.description) console.log(c.dim(`    ${role.description}`));
        if (role.problem && role.agent) console.log(c.red(`    ✗ ${role.problem}`));
        if (role.overlapsGeneral) console.log(c.yellow(`    ⚠ ${role.overlapsGeneral}`));
        if (role.usage) console.log(usageLine(role.usage, "    "));
      }
    }
  }
  console.log(`\n${c.bold("Layers")}  ${c.dim("(later ones win)")}`);
  for (const layer of summary.layers.filter((entry) => inRepository || entry.layer === "global")) {
    const state = layer.hasArmy ? c.green("● army section") : layer.exists ? c.dim("○ file exists, no army section") : c.dim("○ no file");
    console.log(`  ${layer.layer.padEnd(8)} ${state.padEnd(40)} ${c.dim(layer.path)}`);
  }
}

async function cmdArmyInit() {
  const layer = armyLayerFlag("global");
  const filePath = armyLayerPath(layer, { projectDir: repoDir });
  const agentName = value("agent");
  let selectedAgent = null;
  let roleModel = null;
  if (flag("agent") && !agentName) throw new Error("--agent requires a name from agents.yml.");
  if (agentName) {
    const agents = loadAgentsOrExit().agents;
    if (!Object.prototype.hasOwnProperty.call(agents, agentName)) {
      throw new Error(`Unknown agent "${agentName}". Pick one of: ${Object.keys(agents).join(", ")}`);
    }
    selectedAgent = agents[agentName];
    if (flag("model") && !value("model")) throw new Error("--model requires a model name or auto.");
    roleModel = value("model") ?? (selectedAgent.model ? null : "auto");
  }
  const existing = readArmyFile(filePath, { armyOnly: layer !== "project" });
  if (existing?.roles && Object.keys(existing.roles).length && !flag("force")) {
    throw new Error(`${filePath} already defines an army (${Object.keys(existing.roles).join(", ")}). Re-run with --force to replace it.`);
  }
  // Keep a General already defined in this layer; the roster is what init resets.
  const roster = structuredClone(DEFAULT_ARMY);
  if (agentName) {
    for (const role of Object.values(roster.roles)) {
      role.agent = agentName;
      if (roleModel) role.model = roleModel;
    }
  }
  updateArmyInFile(filePath, (army) => ({ ...roster, ...(army.general ? { general: army.general } : {}) }));
  if (layer === "local") ensureLocalLayerIgnored();
  if (json) return out({ written: filePath, layer, roles: Object.keys(DEFAULT_ARMY.roles) });
  console.log(c.green(`✓ Wrote the default army to ${filePath} (${layer}).`));
  if (!agentName) {
    console.log(c.dim("Every role starts on the local model. Next: `nomarmy army general <agent>` (the agent your coordinator session runs on), then `nomarmy army assign <role> <agent>` for any role you want elsewhere."));
    return;
  }
  console.log(c.dim(roleModel === "auto"
    ? `Every role starts on ${agentName} with model auto; the coordinator picks a model per job.`
    : `Every role starts on ${agentName}${roleModel ? ` with model ${roleModel}` : ` using its default model ${selectedAgent.model}`}.`));
  if (agentRunsToolsOnHost(selectedAgent)) {
    console.log(c.yellow(`⚠ ${agentName} runs its tools on the host. Build roles on it will be refused unless allow_host_tools is set in agents.yml.`));
  }
}

function armyPositionals() {
  const result = [];
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--repo", "--agent", "--model"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
      i++;
    } else if (["--global", "--project", "--local", "--json", "--no-check"].includes(arg)) {
      continue;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown army option ${arg}`);
    } else result.push(arg);
  }
  return result;
}

async function cmdArmyAssign() {
  const positional = armyPositionals();
  const [roleName, agentName, model] = positional;
  if (!roleName || !agentName || positional.length > 3) throw new Error("Usage: nomarmy army assign <role> <agent|none> [model|auto] [--global|--project|--local]");
  const layer = armyLayerFlag("global");
  const filePath = armyLayerPath(layer, { projectDir: repoDir });
  const defined = Object.prototype.hasOwnProperty.call(loadArmy({ projectDir: repoDir }).army.roles, roleName);
  if (!defined) throw new Error(`Role "${roleName}" is not defined in any army roster. Run nomarmy army init first.`);
  const target = parseTargetSpec(agentName, model);
  const check = flag("no-check") ? { status: "skipped" } : checkRoleModel(agentName, model);
  if (check.status === "failed") {
    const msg = `${agentName}/${model} ${check.detail} -- nothing was written. Pick a model from: ${check.listed.join(", ") || "(OpenClaw lists none for this agent)"}, or pass --no-check if you're sure.`;
    if (json) { out({ error: msg, check }); process.exit(1); }
    throw new Error(msg);
  }
  assignRoleInFile(filePath, roleName, target);
  if (layer === "local") ensureLocalLayerIgnored();
  const { summary } = loadArmyForCli();
  const role = summary.roles[roleName];
  if (json) return out({ written: filePath, layer, role: roleName, effective: role ?? null, modelCheck: check });
  if (check.status === "listed") console.log(c.dim(`${model} is in OpenClaw's catalog for ${agentName}, and a real test call worked.`));
  else if (check.status === "probed") console.log(c.dim(`${model} isn't in OpenClaw's catalog yet, but a real test call to it worked.`));
  else if (check.status === "unchecked") console.log(c.yellow(`⚠ Couldn't check ${model} (${check.detail}); the first job on this role will find out.`));
  console.log(c.green(`✓ ${roleName} → ${agentName}${model ? ` (${model === "auto" ? "model: the General picks per job" : model})` : ""} in ${filePath} (${layer}).`));
  if (role) {
    if (role.setBy.agent && role.setBy.agent !== layer) console.log(c.yellow(`Note: the ${role.setBy.agent} layer overrides this, so ${roleName} still runs on ${role.agent}.`));
    if (role.problem && role.agent) console.log(c.yellow(`⚠ ${role.problem}.`));
    if (role.overlapsGeneral) console.log(c.yellow(`⚠ ${roleName} ${role.overlapsGeneral}.`));
    if (!role.description) console.log(c.dim(`${roleName} has no description in any layer; the General will only see its name.`));
  }
  if (layer === "project") console.log(c.dim("This is committed with the repo; teammates need an agent with that same name in their own agents.yml."));
}

/**
 * Whether `model` really runs on `agentName`, before a role is pointed at
 * it: listed in OpenClaw's freshly refreshed catalog, or -- since that
 * catalog lags new models (xai/grok-4.7 worked while unlisted) -- answering
 * one real test call. Caught live: gpt-6-sol is in the Codex CLI's own
 * model list but OpenClaw's openai provider answers "Unknown model".
 * Nothing to check for "auto", no model, or a local or unknown agent.
 */
function checkRoleModel(agentName, model) {
  if (!model || model === "auto") return { status: "none" };
  let agent;
  try { agent = loadAgents(globalConfigDir()).agents[agentName]; } catch { return { status: "unchecked", detail: "agents.yml didn't load" }; }
  if (!agent || agent.kind === "local") return { status: "none" };
  const provider = agent.kind === "api" ? openclawProviderId(agent) : agent.provider;
  if (!json) console.log(c.dim(`Checking ${model} against OpenClaw's ${provider} models (a catalog refresh takes a few seconds)...`));
  const listing = runQuiet(openclawCmd(), ["models", "list", "--all", "--refresh"]);
  if (!listing.ok && !listing.out.trim()) return { status: "unchecked", detail: "openclaw isn't reachable" };
  const listed = parseCatalogModels(listing.out, provider);
  // Always one real call: a listed model isn't proof it runs. Muse was
  // listed (catalog refresh lists meta/muse-spark-1.3) while every job on
  // it failed "Unknown model", and an assignment checked only against the
  // list let a Senti review fail 10 seconds in.
  if (probeWorker(provider, model)) return { status: listed.includes(model) ? "listed" : "probed", listed };
  const why = lastProbeFailure ? ` (${lastProbeFailure})` : "";
  return { status: "failed", detail: `${listed.includes(model) ? "is listed in OpenClaw's catalog, but a real test call to it failed" : "isn't in OpenClaw's catalog and a real test call to it failed"}${why}`, listed };
}

// Which agent the General is. Global or local only: it describes the
// person's own coordinator session, which a committed project file can't know.
async function cmdArmyGeneral() {
  const positional = armyPositionals();
  const [agentName] = positional;
  if (!agentName || positional.length !== 1) throw new Error("Usage: nomarmy army general <agent> [--global|--local]");
  const layer = armyLayerFlag("global");
  if (layer === "project") throw new Error("The General is your own coordinator session, so it's set in --global or --local, never in a committed project file.");
  const agents = loadAgentsOrExit().agents;
  if (!Object.prototype.hasOwnProperty.call(agents, agentName)) {
    throw new Error(`Unknown agent "${agentName}". Define it first with \`nomarmy agents add\` (the General's agent is only described, never dispatched to), or pick one of: ${Object.keys(agents).join(", ")}`);
  }
  const filePath = armyLayerPath(layer, { projectDir: repoDir });
  updateArmyInFile(filePath, (army) => ({ ...army, general: agentName }));
  if (layer === "local") ensureLocalLayerIgnored();
  const { summary } = loadArmyForCli();
  const overlaps = Object.entries(summary.roles).filter(([, r]) => r.overlapsGeneral);
  if (json) return out({ written: filePath, layer, general: agentName, overlaps: Object.fromEntries(overlaps.map(([n, r]) => [n, r.overlapsGeneral])) });
  console.log(c.green(`✓ The General is "${agentName}" (${describeAgentLabel(agents[agentName])}), in ${filePath} (${layer}).`));
  for (const [name, role] of overlaps) console.log(c.yellow(`⚠ ${name} ${role.overlapsGeneral}.`));
}

async function cmdArmy() {
  const sub = argv[1] ?? "show";
  if (sub === "show") return cmdArmyShow();
  if (sub === "init") return cmdArmyInit();
  if (sub === "assign") return cmdArmyAssign();
  if (sub === "general") return cmdArmyGeneral();
  throw new Error(`Unknown army subcommand "${sub}". Use: nomarmy army <show|init|assign|general>`);
}

async function cmdConfigPaths() {
  const agentsPath = agentsConfigPath(globalConfigDir());
  const army = ["global", "project", "local"].map((layer) => {
    const p = armyLayerPath(layer, { projectDir: repoDir });
    return { layer, path: p, exists: fs.existsSync(p) };
  });
  if (json) return out({ globalDir: globalConfigDir(), agents: { path: agentsPath, exists: fs.existsSync(agentsPath) }, army });
  console.log(c.bold("nomArmy config") + c.dim(`  (global dir: ${globalConfigDir()})`));
  console.log(`  ${fs.existsSync(agentsPath) ? c.green("●") : c.dim("○")} ${"agents".padEnd(8)} ${c.dim(agentsPath)}`);
  const { limitsPath } = await import("../lib/limits.mjs");
  console.log(`  ${fs.existsSync(limitsPath()) ? c.green("●") : c.dim("○")} ${"limits".padEnd(8)} ${c.dim(limitsPath())}`);
  console.log(c.bold("\nArmy layers"));
  for (const a of army) console.log(`  ${a.exists ? c.green("●") : c.dim("○")} ${a.layer.padEnd(8)} ${c.dim(a.path)}`);
}

// `nomarmy config max-jobs [n]`: api and subscription jobs at once, machine-wide.
async function cmdConfigMaxJobs() {
  const { maxJobs, setMaxJobs, jobsThatFit, vmGibFor } = await import("../lib/limits.mjs");
  const given = argv[2];
  if (given !== undefined) {
    if (!/^\d+$/.test(given)) throw new Error(`max-jobs must be a whole number, got "${given}"`);
    setMaxJobs(Number(given));
  }
  const limit = maxJobs();
  const machine = process.platform === "linux" ? null : pickMachine(spawnSync("podman", ["machine", "inspect"], { encoding: "utf8" }).stdout);
  const fit = jobsThatFit(machine?.memoryMb);
  if (json) return out({ maxJobs: limit.value, source: limit.source, path: limit.path, problem: limit.problem, podmanVmMemoryMb: machine?.memoryMb ?? null, jobsThatFit: fit });
  const from = { file: `set in ${limit.path}`, env: "from NOMARMY_MAX_POOL_WORKERS in this shell (limits.yml doesn't set it)", default: "the default" }[limit.source];
  if (limit.problem) console.log(c.yellow(`⚠ ${limit.problem}`));
  console.log(`${given !== undefined ? c.green("✓ ") : ""}Up to ${c.bold(String(limit.value))} api and subscription jobs at once, across every session (${from}).`);
  console.log(c.dim("Each agent's max_concurrent in agents.yml also applies, and local-model jobs have their own limit."));
  if (given !== undefined) console.log(c.dim("Applies to the next job in every session on this version, no restart."));
  if (fit !== null && limit.value > fit) console.log(c.yellow(`⚠ The Podman VM (${machine.memoryMb / 1024} GiB) fits about ${fit} sandboxes at once; more get refused for memory or cut off. Fix: nomarmy sandbox --memory ${vmGibFor(limit.value)}`));
  if (given === undefined) console.log(c.dim("Change it with `nomarmy config max-jobs <n>` (1 to 32)."));
}

async function cmdConfig() {
  const sub = argv[1] ?? "paths";
  if (sub === "paths") return cmdConfigPaths();
  if (sub === "max-jobs") return cmdConfigMaxJobs();
  throw new Error(`Unknown config subcommand "${sub}". Use: nomarmy config <paths|max-jobs [n]>`);
}

// --- `nomarmy jobs [--watch]`: what's running, from any session -----------
//
// Reads the shared job directory, so it shows every session's jobs. A job
// is running when its status says so AND its server process is alive (a
// server that died mid-job leaves a stale "running" status behind).

function jobsRootDir() {
  return path.join(process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents"), "jobs");
}

function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function collectJobs({ recent = 8, runId = null, projectDir = null } = {}) {
  const root = jobsRootDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return { running: [], recent: [] }; }
  const jobs = names.map((name) => {
    const dir = path.join(root, name);
    const status = readJsonSafe(path.join(dir, "status.json")) ?? {};
    const meta = readJsonSafe(path.join(dir, "metadata.json"));
    const lease = readJsonSafe(path.join(agentStateRoot(), "leases", `${name}.json`));
    const jobRunId = meta?.labels?.runId ?? lease?.runId ?? null;
    const jobProjectDir = meta?.projectDir ?? lease?.repo ?? null;
    if ((runId && jobRunId !== runId) || (projectDir && (!jobProjectDir || path.resolve(jobProjectDir) !== projectDir))) return null;
    const started = Date.parse(status.startedAt ?? meta?.startedAt ?? "") || fs.statSync(dir).mtimeMs;
    const running = status.state === "running" && pidIsAlive(status.serverPid);
    return {
      jobId: status.jobId ?? name, mode: status.mode ?? meta?.mode ?? null, running,
      phase: running ? status.phase : (meta?.outcome ?? (status.state === "running" ? "orphaned" : status.phase ?? "?")),
      agent: status.agent ?? meta?.worker?.provider ?? null, model: status.model ?? meta?.metrics?.worker_model ?? null,
      elapsedSeconds: Math.round(((running ? Date.now() : Date.parse(meta?.finishedAt ?? status.updatedAt ?? "") || Date.now()) - started) / 1000),
      lastTool: status.lastTool ? `${status.lastTool.tool}${status.lastTool.target ? ` ${String(status.lastTool.target).slice(0, 40)}` : ""}` : null,
      filesChanged: status.filesChangedLive ?? meta?.git?.filesChanged?.length ?? null,
      heartbeatAgeSeconds: status.heartbeatAt ? Math.round((Date.now() - Date.parse(status.heartbeatAt)) / 1000) : null,
      started, dir,
    };
  }).filter(Boolean).sort((a, b) => b.started - a.started);
  return { running: jobs.filter((j) => j.running), recent: jobs.filter((j) => !j.running).slice(0, recent) };
}

const fmtSeconds = (n) => (n == null ? "-" : n < 60 ? `${n}s` : n < 3600 ? `${Math.floor(n / 60)}m${String(n % 60).padStart(2, "0")}s` : `${Math.floor(n / 3600)}h${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}m`);

function renderJobs({ running, recent }) {
  const lines = [c.bold(`🍪 nomArmy jobs`) + c.dim(`  ${new Date().toLocaleTimeString()}  (${jobsRootDir()})`), ""];
  lines.push(c.bold(`Running (${running.length})`));
  if (!running.length) lines.push(c.dim("  nothing running"));
  for (const j of running) {
    const beat = j.heartbeatAgeSeconds == null ? c.dim("no heartbeat yet") : j.heartbeatAgeSeconds > 60 ? c.yellow(`heartbeat ${fmtSeconds(j.heartbeatAgeSeconds)} ago`) : c.dim(`heartbeat ${fmtSeconds(j.heartbeatAgeSeconds)} ago`);
    lines.push(`  ${c.cyan(j.jobId)}  ${j.agent ?? "local"}${j.model ? `/${j.model}` : ""}  ${j.phase}  ${fmtSeconds(j.elapsedSeconds)}  ${beat}`);
    lines.push(c.dim(`    last tool: ${j.lastTool ?? "-"}   files changed: ${j.filesChanged ?? "-"}   log: tail -f ${path.join(j.dir, "openclaw.stderr.log")}`));
  }
  lines.push("", c.bold("Recent"));
  for (const j of recent) lines.push(`  ${j.jobId.padEnd(40)} ${String(j.phase).padEnd(20)} ${fmtSeconds(j.elapsedSeconds).padStart(7)}  ${c.dim(`${j.agent ?? ""}${j.model ? `/${j.model}` : ""}`)}`);
  return lines.join("\n");
}

/**
 * `nomarmy jobs --events`: one line per change -- a job started, changed
 * phase, or finished -- and nothing in between. Made for Claude Code's
 * background monitor: the General watches this stream and is woken on
 * each line, instead of polling local_worker_status (each poll costs its
 * seat usage). With --json, one JSON object per line.
 */
async function streamJobEvents() {
  const interval = Math.max(1, Number(value("interval", "3")) || 3) * 1000;
  // A stream nobody reads must still end: a General that ran this as a
  // background command (reported only on exit) was never told jobs had
  // finished, and eight of these streams were left running for days.
  const untilDone = flag("until-done");
  const runId = value("run");
  const projectDir = flag("repo") ? repoDir : null;
  if (!runId && !projectDir) {
    const detail = "watching every job on this machine; use --wait <ids> or --run <id> to scope the watch";
    if (json) console.log(JSON.stringify({ at: new Date().toISOString(), event: "scope", detail }));
    else console.log(detail);
  }
  const idleLimitMs = Math.max(1, Number(value("idle-minutes", "30")) || 30) * 60000;
  let idleSinceMs = Date.now(), sawRunning = false;
  const seen = new Map();
  const emit = (event, job, detail = "") => {
    if (json) console.log(JSON.stringify({ at: new Date().toISOString(), event, jobId: job.jobId, agent: job.agent, model: job.model, phase: job.phase, detail }));
    else console.log(`${new Date().toLocaleTimeString()}  ${event.padEnd(9)} ${job.jobId}  ${job.agent ?? "local"}${job.model ? `/${job.model}` : ""}${detail ? `  ${detail}` : ""}`);
  };
  process.on("SIGINT", () => process.exit(0));
  let first = true;
  for (;;) {
    const { running, recent } = collectJobs({ recent: 20, runId, projectDir });
    const now = new Map([...running, ...recent].map((j) => [j.jobId, j]));
    for (const j of running) {
      const prev = seen.get(j.jobId);
      if (!prev) { if (!first) emit("started", j, j.phase); else emit("running", j, j.phase); }
      else if (prev.phase !== j.phase) emit("phase", j, `${prev.phase} -> ${j.phase}`);
    }
    for (const [id, prev] of seen) {
      const j = now.get(id);
      if (prev.running && j && !j.running) emit("finished", j, `${j.phase} after ${fmtSeconds(j.elapsedSeconds)}`);
    }
    // A finished record can briefly lack its run label after its lease is removed.
    // Keep the running snapshot until the stamped record becomes visible.
    const pending = (runId || projectDir) ? [...seen].filter(([id, j]) => j.running && !now.has(id)) : [];
    seen.clear();
    for (const [id, j] of [...now, ...pending]) seen.set(id, j);
    first = false;
    if (running.length || pending.length) { sawRunning = true; idleSinceMs = Date.now(); }
    else if (untilDone && sawRunning) {
      if (json) console.log(JSON.stringify({ at: new Date().toISOString(), event: "done", detail: "every job seen running has finished" }));
      else console.log(`${new Date().toLocaleTimeString()}  done      every job seen running has finished`);
      return;
    } else if (Date.now() - idleSinceMs >= (untilDone ? Math.min(idleLimitMs, 120000) : idleLimitMs)) {
      const why = untilDone ? "no job was running to wait for" : `nothing has run for ${Math.round(idleLimitMs / 60000)} minutes`;
      if (json) console.log(JSON.stringify({ at: new Date().toISOString(), event: "idle", detail: why }));
      else console.log(`${new Date().toLocaleTimeString()}  idle      ${why}; exiting`);
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

const commitSha = (commit) => (typeof commit === "string" ? commit : typeof commit?.sha === "string" ? commit.sha : null);

/** Wait for selected jobs in the shared, cross-session state directory. */
async function waitForJobCli() {
  const waitIndex = argv.indexOf("--wait");
  const requested = [];
  for (let i = waitIndex + 1; i < argv.length && !argv[i].startsWith("--"); i++) requested.push(...argv[i].split(","));
  const jobIds = [...new Set(requested)];
  const timeoutSeconds = Number(value("timeout", "1800"));
  const errorOut = (message) => {
    if (json) out({ error: message });
    else console.error(`nomarmy jobs: ${message}`);
    process.exitCode = 2;
  };
  if (!jobIds.length) return errorOut("--wait needs a job id");
  if (jobIds.some((id) => !id || path.basename(id) !== id || id === "." || id === "..")) return errorOut("--wait needs valid job ids");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) return errorOut("--timeout must be a non-negative number of seconds");
  for (const jobId of jobIds) {
    if (!fs.existsSync(path.join(jobsRootDir(), jobId)) && !fs.existsSync(path.join(agentStateRoot(), "leases", `${jobId}.json`))) {
      return errorOut(`unknown job id: ${jobId}`);
    }
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  const results = await Promise.all(jobIds.map(async (jobId) => {
    const jobDir = path.join(jobsRootDir(), jobId);
    for (;;) {
      const status = readJsonSafe(path.join(jobDir, "status.json")) ?? {};
      const meta = readJsonSafe(path.join(jobDir, "metadata.json")) ?? {};
      if (status.state === "finished" || meta.outcome) {
        const issues = Array.isArray(meta.issues) ? meta.issues : Array.isArray(status.issues) ? status.issues : [];
        const result = {
          jobId,
          outcome: meta.outcome ?? status.outcome ?? null,
          coordinatorStatus: meta.coordinatorStatus ?? status.coordinatorStatus ?? null,
          branch: meta.branch ?? status.branch ?? null,
          commit: commitSha(meta.commit) ?? commitSha(status.commit),
          issues,
        };
        if (json) out(result);
        else {
          const firstIssue = issues[0];
          const issueText = firstIssue == null ? null : typeof firstIssue === "string" ? firstIssue : firstIssue.message ?? JSON.stringify(firstIssue);
          console.log([result.jobId, result.outcome ?? "unknown", result.coordinatorStatus ?? "unknown",
            result.branch ? `branch=${result.branch}` : null, result.commit ? `commit=${result.commit}` : null,
            issueText ? `issue=${issueText}` : null].filter(Boolean).join(" "));
        }
        return result.coordinatorStatus === "complete" ? 0 : 1;
      }
      if (Date.now() >= deadline) {
        errorOut(`timed out waiting for job ${jobId}`);
        return 2;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(1, deadline - Date.now()))));
    }
  }));
  process.exitCode = Math.max(...results);
}

/**
 * `nomarmy jobs --prune [--older-than DAYS]`: remove runtime/ (per-job npm
 * cache, harness state such as Codex's, OpenClaw's transcript) from
 * finished jobs older than DAYS (default 2). Each job's record, logs,
 * report and any retained worktree stay. Job storage reached 1.9 GB and
 * then 2.4 GB again within a day of real runs, mostly this.
 */
function pruneJobRuntimeCli() {
  const days = Math.max(0, Number(value("older-than", "2")) || 0);
  const { pruned, scratchCleared, freedBytes: bytes } = pruneJobRuntime({ stateRoot: agentStateRoot(), olderThanMs: days * 86400000 });
  if (json) return out({ pruned, scratchCleared, freedBytes: bytes, olderThanDays: days });
  const parts = [pruned ? `runtime data from ${pruned} finished job(s) older than ${days} day(s)` : null, scratchCleared ? `OpenClaw scratch files from ${scratchCleared} more recent one(s)` : null].filter(Boolean);
  console.log(parts.length ? c.green(`✓ Removed ${parts.join(" and ")}, freeing ${(bytes / 1024 ** 3).toFixed(2)} GB. Records and reports are kept.`) : c.dim(`Nothing to prune: no finished job older than ${days} day(s) still has runtime data.`));
}

async function cmdJobs() {
  if (flag("wait")) return waitForJobCli();
  if (flag("stop")) {
    const r = requestJobStop({ jobsRoot: jobsRootDir(), jobId: value("stop"), reason: value("reason") });
    if (json) return out(r);
    console.log(r.ok ? c.green(`✓ ${r.message}`) : c.red(`✗ ${r.message}`));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (flag("events")) return streamJobEvents();
  if (flag("prune")) return pruneJobRuntimeCli();
  if (json) return out(collectJobs());
  if (!flag("watch")) return console.log(renderJobs(collectJobs()));
  // No `watch` on macOS, and a shell loop can't run through Claude Code's `!`.
  const interval = Math.max(1, Number(value("interval", "3")) || 3) * 1000;
  process.on("SIGINT", () => { process.stdout.write("\n"); process.exit(0); });
  for (;;) {
    process.stdout.write("\u001b[2J\u001b[H" + renderJobs(collectJobs()) + c.dim("\n\nCtrl-C to stop.") + "\n");
    await new Promise((r) => setTimeout(r, interval));
  }
}

// `nomarmy health`: run the checks now (the MCP server also runs them every
// 6 hours) and record them, which also refreshes the status line's warning.
// This install's settings from config/common.env (the execution mode and the
// model server's address, as `nomarmy connect` gives the MCP server), under
// anything set (non-empty) in the environment.
function installEnv() {
  const set = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  return { ...deriveWorkerModelEnv(nomarmyRoot), ...set };
}

async function cmdHealth() {
  const { checkAndRecordHealth } = await import("../lib/health.mjs");
  const stateRoot = process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents");
  const { result } = await checkAndRecordHealth({ projectDir: repoDir, stateRoot, configDir: globalConfigDir(), env: installEnv() });
  if (result.issues.some((i) => i.severity === "error")) process.exitCode = 1;
  if (json) return out(result);
  console.log(c.bold("🍪 nomArmy health") + c.dim(`  ${new Date(result.checkedAt).toLocaleString()}`));
  if (!result.issues.length) { console.log(c.green("\n✓ Nothing to fix.")); return; }
  const mark = { error: c.red("✗"), warn: c.yellow("⚠"), info: c.dim("·") };
  for (const i of result.issues) {
    console.log(`\n${mark[i.severity]} ${c.bold(i.title)}`);
    console.log(c.dim(`  ${i.detail}`));
    if (i.fix) console.log(`  fix: ${i.fix}`);
  }
  if (result.issues.some((i) => i.severity === "error")) process.exitCode = 1;
}

async function cmdStatusline() {
  const { statusLineText } = await import("../lib/statusline.mjs");
  let session = {};
  if (!process.stdin.isTTY) { try { session = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* no session JSON */ } }
  process.stdout.write(`${statusLineText({ session })}\n`);
}

// `stats --share`: markdown for a PR description or README; `--badge [path]`:
// an SVG badge to commit, with the README line for it (lib/share.mjs).
async function shareStats(stats) {
  const { shareMarkdown, badgeSvg, badgeMarkdown } = await import("../lib/share.mjs");
  const scope = value("run") ? "this feature run" : value("since") ? `since ${value("since")}` : null;
  if (flag("share")) console.log(shareMarkdown(stats, { scope }));
  if (flag("badge")) {
    const given = value("badge");
    const top = spawnHostGitSync(process.cwd(), ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    const root = top.status === 0 ? top.stdout.trim() : process.cwd();
    const file = path.resolve(root, given ?? path.join(".github", "nomarmy-badge.svg"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, badgeSvg(stats));
    const rel = path.relative(root, file).split(path.sep).join("/");
    console.log(`${flag("share") ? "\n" : ""}${c.green("✓")} Wrote ${rel}. Commit it and add this to your README:\n\n  ${badgeMarkdown(rel)}\n`);
    console.log(c.dim("Re-run nomarmy stats --badge after more jobs to refresh the numbers."));
  }
}

function cmdStats() {
  const stateRoot = process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents");
  const records = loadJobRecords(path.join(stateRoot, "jobs"));
  let repo = null;
  if (value("repo")) repo = resolveRepo(records, value("repo"));
  else if (!flag("all-repos")) {
    try { repo = execHostGitSync(repoDir, ["rev-parse", "--show-toplevel"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { throw new Error(`${repoDir} isn't inside a git repository; run nomarmy stats from one, or pass --repo <name> or --all-repos`); }
  }
  let agentFor = () => null;
  try { agentFor = agentLookup(loadAgents(globalConfigDir()).agents, agentProviderId); } catch { /* no agents.yml: commands name <agent> */ }
  const stats = computeStats(records, { repo, sinceMs: parseSince(value("since")), untilMs: parseSince(value("until")), role: value("role"), model: value("model"), runId: value("run"), agentFor, allSuggestions: flag("all-suggestions") });
  if (json) return out(stats);
  if (flag("share") || flag("badge")) return shareStats(stats);
  console.log(flag("details") ? formatStats(stats) : formatStatsSummary(stats, { c }));
}

// Read one line without echoing it: stty -echo around the read, restored
// even if the read fails. Windows has no stty, so it says the input shows.
async function readHiddenLine(prompt) {
  const hide = process.stdin.isTTY && process.platform !== "win32";
  if (!hide) console.log(c.yellow("(your input will be visible as you type)"));
  const rl = createInterface({ input, output });
  try {
    if (hide) spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
    return (await rl.question(prompt)).trim();
  } finally {
    if (hide) { spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] }); process.stdout.write("\n"); }
    rl.close();
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// One tiny System One request, to prove the key and the route work.
async function testJev(settings) {
  const { answers } = await askJev({ key: settings.key, model: settings.model, state: { text: "The build finished and all 12 tests passed." },
    questions: { passed: { type: "noul", instructions: "Does the text say the tests passed?", criteria: { true: "It says the tests passed", false: "It doesn't" } } } });
  return typeof answers.passed?.noul === "number";
}

async function cmdValidators() {
  const [sub = "list", name] = argv.slice(1).filter((a) => !a.startsWith("--"));
  if (sub === "list") {
    let config = {};
    try { config = loadValidators(); } catch (error) { if (json) return out({ error: error.message }); console.log(c.red(error.message)); process.exitCode = 1; return; }
    const judge = config.judge ? { enabled: config.judge.enabled, agent: config.judge.agent, model: config.judge.model, checks: config.judge.checks, hostTools: config.judge.host_tools } : null;
    const jev = config.jev ? { enabled: config.jev.enabled, checks: config.jev.checks, model: config.jev.model, key: config.jev.key_env ? `env ${config.jev.key_env}` : config.jev.key_file, keyReadable: Boolean(jevSettings()) } : null;
    if (json) return out({ path: validatorsPath(), jev, judge });
    if (!jev && !judge) { console.log("No validators configured. Add one with: nomarmy validators add jev, or nomarmy validators add judge --agent <name> --model <model>"); return; }
    if (jev) console.log(`Jev: ${jev.enabled ? c.green("on") : "off"} (${jev.model}); checks: ${jev.checks.join(", ")}; key: ${jev.key}${jev.keyReadable ? "" : c.red(" (not readable)")}`);
    if (judge) console.log(`Judge: ${judge.enabled ? c.green("on") : "off"} (${judge.agent}/${judge.model}); checks: ${judge.checks.join(", ")}${judge.hostTools ? c.yellow("; host tools allowed") : ""}`);
    return;
  }
  if (name === "judge") return cmdValidatorsJudge(sub);
  if (name !== "jev") throw new Error("Usage: nomarmy validators <list|add jev|test jev|remove jev|add judge|test judge|remove judge>");
  if (sub === "add") {
    if (!json) {
      console.log(c.bold("🍪 Jev (TypeSafe) for nomArmy's semantic checks\n"));
      console.log("It checks that a scout's cited lines support its finding, and that a worker's report matches its diff.");
      console.log("Its answers only add review flags; they never pass a check or allow a commit.");
      console.log(c.yellow("It sends excerpts of your code (findings, cited lines, diffs, worker reports) to TypeSafe.\n"));
    }
    const key = flag("key-stdin") ? await readStdin() : await readHiddenLine("TypeSafe API key (not shown): ");
    const saved = saveJevKey(key);
    let ok = false, why = null;
    try { ok = await testJev(jevSettings()); } catch (error) { why = error.message; }
    if (json) return out({ saved: true, keyFile: saved.keyFile, configPath: saved.configPath, test: ok ? "pass" : "fail", reason: why });
    console.log(c.green(`✓ Saved the key to ${saved.keyFile} (readable only by you) and turned Jev on in ${saved.configPath}.`));
    console.log(ok ? c.green("✓ Test call answered. New jobs use it; restart open coordinator sessions to pick it up.") : c.red(`✗ Test call failed: ${why ?? "no answer"}. Check the key, then: nomarmy validators test jev`));
    if (!ok) process.exitCode = 1;
    return;
  }
  if (sub === "test") {
    const settings = jevSettings();
    if (!settings) throw new Error("Jev isn't configured, or its key isn't readable. Add it with: nomarmy validators add jev");
    let ok = false, why = null;
    try { ok = await testJev(settings); } catch (error) { why = error.message; }
    if (json) return out({ test: ok ? "pass" : "fail", reason: why });
    console.log(ok ? c.green("✓ Jev answered.") : c.red(`✗ Jev test call failed: ${why ?? "no answer"}`));
    if (!ok) process.exitCode = 1;
    return;
  }
  if (sub === "remove") {
    const result = removeJev();
    if (json) return out(result);
    console.log(c.green(`✓ Jev is off${result.removedKey ? ", and its saved key is deleted" : ""}.`));
    return;
  }
  throw new Error("Usage: nomarmy validators <list|add jev|test jev|remove jev>");
}

async function cmdValidatorsJudge(sub) {
  const agents = loadAgents(globalConfigDir()).agents;
  const resolve = () => judgeSettings({ agents, providerOf: agentProviderId, runsOnHost: agentRunsToolsOnHost });
  const probe = async (settings) => probeModel({ provider: settings.provider, model: settings.model, stateRoot: process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents") });
  if (sub === "add") {
    let agent = value("agent"), model = value("model"), dominantBuilderVendor = null;
    let rl = null;
    const question = async (prompt) => {
      rl ??= createInterface({ input, output });
      return rl.question(c.bold(prompt));
    };
    if (!agent) {
      if (!process.stdin.isTTY || json) throw new Error("Usage: nomarmy validators add judge --agent <name> --model <model> [--host-tools]");
      const roles = loadArmy({ projectDir: repoDir }).army.roles;
      const guided = judgeAgentChoices({ agents, roles, providerOf: agentProviderId, runsOnHost: agentRunsToolsOnHost });
      dominantBuilderVendor = guided.dominantBuilderVendor;
      if (!guided.choices.length) throw new Error("No api or subscription agents are configured in agents.yml.");
      agent = (await chooseJudgeAgent({ choices: guided.choices, ask: question, write: (line) => console.log(line) })).name;
    }
    if (!agents[agent]) throw new Error(`"${agent}" isn't an agent in agents.yml. Agents: ${Object.keys(agents).join(", ") || "(none)"}`);
    if (!model) {
      if (!process.stdin.isTTY || json) throw new Error("Usage: nomarmy validators add judge --agent <name> --model <model> [--host-tools]");
      const listed = catalogModelsFor(agentProviderId(agents[agent]));
      if (listed.length) {
        console.log(`Models for ${agent}:`);
        listed.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
      }
      const fallback = agents[agent].model ?? "";
      const answer = String(await question(`Model id${fallback ? ` [${fallback}]` : ""}: `)).trim();
      model = /^\d+$/.test(answer) && listed[Number(answer) - 1] ? listed[Number(answer) - 1] : answer || fallback;
      if (!model) { rl?.close(); throw new Error("A model id is required."); }
    }
    let hostTools = flag("host-tools");
    if (agentRunsToolsOnHost(agents[agent]) && !hostTools) {
      if (!process.stdin.isTTY || json) {
        const quote = (arg) => /^[A-Za-z0-9_./:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
        const rerun = ["nomarmy", ...argv, "--host-tools"].map(quote).join(" ");
        throw new Error(`agent "${agent}" runs its tools on this machine, and a judge reads text the worker wrote. Refusing without explicit consent. Re-run: ${rerun}`);
      }
      const allowed = await confirmJudgeHostTools({ agent, ask: question, write: (line) => console.log(line) });
      if (!allowed) { rl?.close(); console.log(c.dim("Canceled; nothing written.")); return; }
      hostTools = true;
    }
    rl?.close();
    const saved = saveJudge({ agent, model, hostTools });
    const settings = resolve();
    if (settings?.problem) throw new Error(settings.problem);
    const test = await probe(settings);
    if (json) return out({ saved: true, configPath: saved.configPath, test: test.ok ? "pass" : test.refused ? "refused" : "inconclusive", reason: test.reason });
    console.log(c.green(`✓ The judge is ${agent}/${model}, in ${saved.configPath}.`));
    if (dominantBuilderVendor === null) {
      try {
        const roles = loadArmy({ projectDir: repoDir }).army.roles;
        dominantBuilderVendor = judgeAgentChoices({ agents, roles, providerOf: agentProviderId, runsOnHost: agentRunsToolsOnHost }).dominantBuilderVendor;
      } catch { /* no readable army means there is no builder comparison */ }
    }
    if (dominantBuilderVendor && agentProviderId(agents[agent]) === dominantBuilderVendor) console.log(c.yellow("Note: this judge uses the same vendor as most build roles, so its verdicts are not independent of those builders."));
    console.log(test.ok ? c.green("✓ Test call answered. New implement jobs use it; restart open coordinator sessions to pick it up.") : c.red(`✗ Test call ${test.refused ? "refused" : "didn't answer"}: ${test.reason ?? "no answer"}`));
    if (!test.ok) process.exitCode = 1;
    return;
  }
  if (sub === "test") {
    const settings = resolve();
    if (!settings) throw new Error("No judge configured. Add one with: nomarmy validators add judge --agent <name> --model <model>");
    if (settings.problem) throw new Error(settings.problem);
    const test = await probe(settings);
    if (json) return out({ test: test.ok ? "pass" : "fail", reason: test.reason });
    console.log(test.ok ? c.green(`✓ ${settings.agent}/${settings.model} answered.`) : c.red(`✗ ${test.reason ?? "no answer"}`));
    if (!test.ok) process.exitCode = 1;
    return;
  }
  if (sub === "remove") {
    removeJudge();
    return json ? out({ removed: true }) : console.log(c.green("✓ The judge is off."));
  }
  throw new Error("Usage: nomarmy validators <add judge --agent <name> --model <model> [--host-tools]|test judge|remove judge>");
}

// `nomarmy mcp`: what a --scope project registration runs. Nothing goes to
// stdout but the server's own protocol.
function cmdMcp() {
  const { serverPath, env } = portableServerLaunch({ nomarmyRoot });
  const child = spawn(process.execPath, [serverPath], { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
}

const commands = { stats: cmdStats, validators: cmdValidators, mcp: cmdMcp, scan: cmdScan, validate: cmdValidate, sizing: cmdSizing, init: cmdInit, setup: cmdSetup, install: cmdInstall, model: cmdModel, agents: cmdAgents, army: cmdArmy, jobs: cmdJobs, statusline: cmdStatusline, health: cmdHealth, config: cmdConfig, update: cmdUpdate, connect: cmdConnect, sandbox: cmdSandbox, start: cmdStart, stop: cmdStop, uninstall: cmdUninstall, help: () => usage(0) };
// doctor command
async function cmdDoctor() {
  if (windowsFrontEnd()) {
    process.exitCode = windowsDoctor({ json, argv });
    return;
  }
  // Import lazily to avoid circular dependencies
  const { runDoctor } = await import("../lib/doctor.mjs");
  const agents = loadAgentsOrExit().agents;
  const vendors = configuredSubscriptionVendors(agents);
  let armySummary = null;
  try { armySummary = describeArmy(loadArmy({ projectDir: repoDir }), { agents }); } catch { /* other doctor checks still run */ }
  let checks;
  if (flag("fix")) {
    const repaired = await repairOpenclaw({
      command: openclawCmd(), vendors, yes: flag("yes"), isTTY: Boolean(input.isTTY),
      print: json ? console.error : console.log,
      ask: async (prompt) => {
        const rl = createInterface({ input, output: json ? process.stderr : output });
        try { return await rl.question(prompt); } finally { rl.close(); }
      },
    });
    checks = repaired.checks;
    if (!repaired.ok && !checks.some((check) => !check.ok)) checks.push({ id: "openclaw-repair", ok: false, message: "OpenClaw repair was declined or failed.", fix: "nomarmy doctor --fix --yes" });
  } else {
    checks = verifyOpenclaw({ command: openclawCmd(), vendors });
  }
  await runDoctor({ json, exit: true, env: installEnv(), additionalChecks: checks,
    runtime: { agents, armySummary, openclawCmd: openclawCmd() } });
}
commands.doctor = cmdDoctor;
if (windowsFrontEnd() && windowsPlan(argv) === "FORWARD") {
  process.exit(windowsForward(argv));
}
if (!command && !flag("help")) {
  // New users typed `nomarmy` and got the whole command reference.
  console.log(`${c.bold("nomArmy")}: bounded coding workers with independently verified results.\n\n  New here?   ${c.cyan("nomarmy setup")}   walks you through it, one step at a time\n  All commands: ${c.cyan("nomarmy help")}\n  Docs: https://github.com/rayson-tech/nomarmy`);
  process.exit(0);
}
if (flag("help") || !commands[command]) usage(command && !commands[command] ? 2 : 0);

try {
  await commands[command]();
} catch (err) {
  if (json) out({ error: err.message });
  else console.error(`nomarmy ${command}: ${err.message}`);
  process.exit(1);
}
