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
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, validateConfig, stringifyConfig, findConfigFile, parseYaml, CONFIG_FILENAMES } from "../lib/config.mjs";
import { scanRepository, compareEvidence } from "../lib/scan.mjs";
import { buildConfigProposal } from "../lib/propose.mjs";
import { detectHardware } from "../lib/hardware.mjs";
import { readGGUFMetadata, resolveModelPath, totalSplitBytes } from "../lib/gguf.mjs";
import { recommend, customRecommendation, evaluateConfig, bytesPerKvElementForCacheTypes, MIN_CONTEXT_PER_NOM } from "../lib/sizing.mjs";
import { connectClaude, connectCodex, connectCursor, cursorAlreadyConnected, deriveWorkerModelEnv } from "../lib/connect.mjs";
import { ID_RE, AUTH_ENV_NAME_RE, OPENCLAW_PROVIDER_ID_RE, openclawProviderId, isNativeProviderType } from "../lib/dispatch-schema.mjs";
import { loadAgents, readAgentsFile, writeAgentsFile, agentsConfigPath, apiAgentAsPoolEntry, describeAgent as describeAgentLabel, agentRunsToolsOnHost, agentProviderId, AGENT_KINDS, API_PROVIDER_TYPES, RESERVED_AGENT_NAMES, BUILTIN_LOCAL_AGENT } from "../lib/agents.mjs";
import { loadArmy, mergeArmy, describeArmy, readArmyFile, updateArmyInFile, assignRoleInFile, parseTargetSpec, armyLayerPath, globalConfigDir, DEFAULT_ARMY, ARMY_PHASES, LOCAL_CONFIG_FILENAME } from "../lib/army.mjs";
import { parseLlamaUrl } from "../lib/execution.mjs";
import { setupSteps, formatSetupSteps, runSetupPlaybook } from "../lib/setup-steps.mjs";
import { readUsageSnapshots } from "../lib/usage-limits.mjs";
import { pickMachine, planResize } from "../lib/sandbox-vm.mjs";
import { MIN_PODMAN_VM_MB } from "../lib/doctor.mjs";
import { liveLeases } from "../lib/slots.mjs";
import { ensureProviderConfig } from "../lib/openclaw-config.mjs";
import { recordProbeSuccess } from "../lib/health.mjs";
import { pruneJobRuntime } from "../lib/prune.mjs";
import { SUBSCRIPTION_VENDORS, parseOpenclawVersion, versionAtLeast, parseCatalogModels, parseCliLoginStatus, probeOutcome, parseMuseAuthDescriptor, extractMintedKey } from "../lib/subscription-setup.mjs";

// Add a new coordinator: add its name here, teach commandExists/connectTarget
// about it below (a JSON-file target like Cursor has no PATH binary to check
// and should short-circuit commandExists to true), and give cmdUpdate its own
// "already connected, so resync" detection if it has no CLI to probe.
const KNOWN_TARGETS = ["claude", "codex", "cursor"];

function connectTarget(target, { nomarmyRoot, run }) {
  if (target === "claude") return connectClaude({ nomarmyRoot, run });
  if (target === "codex") return connectCodex({ nomarmyRoot, run });
  if (target === "cursor") return connectCursor({ nomarmyRoot, run });
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
const THINKING_LEVELS = ["low", "medium", "high"];
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
  update          Pull the latest nomArmy code and re-sync the installed
                  MCP copy (fast-forward only; refuses on local changes).
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
                            --owner (subscription); and optionally
                            --max-concurrent --context-window
                            --thinking [low|medium|high] --no-thinking
                  update <name>
                            change the model (picked from what OpenClaw
                            lists; a subscription gets a real test call),
                            slot, auth_env, base_url, max_concurrent,
                            context_window or thinking. Kind, provider and
                            owner stay fixed: that's a different agent.
                            --no-model clears the default model, so every
                            role or job names its own.
                            (--json with the matching flags; --probe to
                            test-call a subscription's new model first)
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
  jobs [--watch|--events|--prune|--wait <jobId>] [--interval N] [--older-than DAYS]
                  what's running across every session (agent, model, phase,
                  last tool call, files changed, heartbeat) and what just
                  finished; --watch redraws every N seconds (default 3);
                  --events prints one line per start, phase change and
                  finish (for Claude Code's background monitor; --json for
                  JSON lines); --prune removes the bulky runtime data
                  from finished jobs older than DAYS (default 2), keeping
                  their records, reports and any retained worktree;
                  --wait <jobId> [--timeout <seconds>] blocks for one job
                  to finish (default timeout 1800; --json is supported)
  health          check what's likely to break a run before it does:
                  expiring logins, an outdated OpenClaw or plugin, roles
                  that can't be dispatched, an unloadable agents.yml,
                  piled-up job storage. The MCP server also runs this
                  every 6 hours and notifies once per new warning
  statusline      the one-line summary Claude Code's status line shows
                  (installed by \`nomarmy connect claude\` when no status
                  line is set); reads the session JSON on stdin
  connect [claude] [codex] [cursor]
                  (Re-)register the MCP server with one or more coordinators.
                  With no target and not --json, prompts an interactive
                  multi-select instead.
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
    for (const n of notes) console.log(`  ${n.message ?? n}`);
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
  if (drift.summary) console.log(`${drift.summary}\n`);
  for (const section of ["services", "ports", "environment", "commandKinds"]) {
    const d = drift[section];
    if (!d) continue;
    for (const m of d.missingFromConfig ?? []) console.log(`  repo has, config omits:  ${section}: ${m}`);
    for (const m of d.missingFromRepo ?? []) console.log(`  config has, repo lacks:  ${section}: ${m}`);
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
const nomarmyRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Read one KEY=VALUE line's value, or null if the file or key doesn't exist. */
function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  const m = fs.readFileSync(filePath, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

/** Read-modify-write one KEY=VALUE line, replacing it if present, appending if not -- the exact pattern scripts/select-model.mjs already uses for config/common.env. */
function writeEnvLine(filePath, key, value) {
  const existingText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const line = `${key}=${value}`;
  const updated = new RegExp(`^${key}=.*$`, "m").test(existingText)
    ? existingText.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${existingText.trimEnd()}\n${line}\n`.replace(/^\n/, "");
  fs.writeFileSync(filePath, updated);
}

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
    label: "Qwen3-Coder-Next (shipped default; no thinking mode -- 0 failures across every case tested tonight)",
    repo: "Qwen/Qwen3-Coder-Next-GGUF", quant: "Q4_K_M", alias: "qwen3-coder-next", thinking: false, recommended: true,
  },
  "gpt-oss-20b": {
    label: "gpt-oss-20b (thinking, use reasoning: medium -- fastest of every model tested on the hardest case: 62s/0 failures; reasoning: high on the SAME ticket was the worst result measured: 318s/4 failures)",
    repo: "ggml-org/gpt-oss-20b-GGUF", quant: "MXFP4", alias: "gpt-oss-20b", thinking: true,
  },
  "qwen3.6-27b": {
    label: "Qwen3.6-27B (thinking, use reasoning: medium -- best measured reliability, noticeably slower per-token; reasoning: high caused a full timeout on an open-ended task)",
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

function setupChecklist() {
  const common = path.join(nomarmyRoot, "config", "common.env");
  const chosen = readEnvValue(common, "NOMARMY_SETUP_PROFILE");
  const probeCommand = (binary, args) => {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 10000 });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const project = setupProjectDir();
  const profileFile = chosen ? path.join(nomarmyRoot, "config", "profiles", `${chosen}.env`) : null;
  const root = (process.env.NOMARMY_INSTALL_ROOT || (profileFile && readEnvValue(profileFile, "NOMARMY_INSTALL_ROOT")) || readEnvValue(common, "NOMARMY_INSTALL_ROOT") || "$HOME/.local/share/nomarmy-local-agents").replace(/\$HOME|\$\{HOME\}/g, os.homedir());
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(root, "install.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") marker = {}; }
  const version = probeCommand("openclaw", ["--version"]);
  // `mcp list` would connect to every server; `mcp get` only looks this one up.
  const registered = !marker && Boolean(version) && ["claude", "codex"].some((name) => spawnSync(name, ["mcp", "get", "nomarmy-local-worker"], { stdio: "ignore", timeout: 10000 }).status === 0);
  // An install from before setup recorded its profile: the marker's, else the
  // execution mode's, else (a working local install) install.sh's default.
  const execution = readEnvValue(common, "NOMARMY_EXECUTION");
  const profile = chosen ?? marker?.profile
    ?? (["hosted", "remote", "bedrock"].includes(execution) ? execution : null)
    ?? (registered ? defaultLocalProfile() : null);
  return setupSteps({
    mode: () => ({ profile, host: readEnvValue(common, "NOMARMY_LLAMA_HOST"), port: readEnvValue(common, "NOMARMY_LLAMA_PORT") }),
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
  const profile = value("profile", readEnvValue(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_SETUP_PROFILE"));
  if (!profile) throw new Error("Choose a profile first: nomarmy setup --choose (or install --profile <name>).");
  const result = spawnSync("bash", [path.join(nomarmyRoot, "install.sh"), "--profile", profile, ...(flag("no-claude") ? ["--no-claude"] : [])], { stdio: "inherit", cwd: nomarmyRoot });
  process.exitCode = result.status ?? 1;
}

async function cmdSetup() {
  if (flag("status") || (!flag("choose") && !flag("hosted") && !flag("llama-url") && !json)) {
    if (flag("status") || !process.stdin.isTTY) {
      const steps = setupChecklist();
      return json ? out(steps) : console.log(formatSetupSteps(steps));
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
        const common = path.join(nomarmyRoot, "config", "common.env");
        fs.mkdirSync(path.dirname(common), { recursive: true });
        writeEnvLine(common, "NOMARMY_EXECUTION", "bedrock");
        writeEnvLine(common, "NOMARMY_SETUP_PROFILE", "bedrock");
        console.log("Next: nomarmy install");
        return;
      }
    } finally { rl.close(); }
  }
  const hosted = flag("hosted");
  const hasLlamaUrl = flag("llama-url");
  if (hosted && hasLlamaUrl) throw new Error("--hosted and --llama-url cannot be used together.");

  if (hosted || hasLlamaUrl) {
    const commonPath = path.join(nomarmyRoot, "config", "common.env");

    if (hosted) {
      const next = [
        "nomarmy install",
        "nomarmy agents add",
        "nomarmy army init --agent <name>",
      ];
      fs.mkdirSync(path.dirname(commonPath), { recursive: true });
      writeEnvLine(commonPath, "NOMARMY_EXECUTION", "hosted");
      writeEnvLine(commonPath, "NOMARMY_SETUP_PROFILE", "hosted");
      if (json) return out({ written: commonPath, execution: "hosted", next });
      console.log(c.green(`✓ Wrote NOMARMY_EXECUTION=hosted to ${path.relative(nomarmyRoot, commonPath)}.`));
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
    console.log(c.green(`✓ Wrote the remote llama-server settings to ${path.relative(nomarmyRoot, commonPath)}.`));
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
      console.log(`More noms ${c.dim(`(confidence: ${res.confidence})`)}: ${c.green(res.summary ?? JSON.stringify(res.env))}`);
      if (res.nominal && !res.nominal.sameAsRecommended) {
        console.log(`Nominal: ${res.nominal.fits ? c.dim(res.nominal.summary) : c.red(`${res.nominal.summary} DOES NOT FIT either -- nothing on this machine does.`)}`);
      }
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
        console.log(`  ${c.cyan("1.")} More noms -- as many as fit in memory`);
        console.log(`  ${c.cyan("2.")} Nominal -- 1 nom, matching this project's own shipped profiles`);
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
    const profilePath = path.join(nomarmyRoot, "config", "profiles", `${profileName}.env`);
    const commonPath = path.join(nomarmyRoot, "config", "common.env");

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
      console.log(c.bold(`\nAbout to write ${path.relative(nomarmyRoot, profilePath)}:`));
      for (const [k, v] of Object.entries(profileWrites)) console.log(c.dim(`  ${k}=${v}`));
      if (model?.kind === "known") {
        console.log(c.bold(`\nAnd ${path.relative(nomarmyRoot, commonPath)}:`));
        console.log(c.dim(`  NOMARMY_MODEL_REPO=${model.repo}`));
        console.log(c.dim(`  NOMARMY_MODEL_QUANT=${model.quant}`));
        console.log(c.dim(`  NOMARMY_MODEL_ALIAS=${model.alias}`));
        console.log(c.dim(`  NOMARMY_WORKER_MODEL=${model.alias}`));
        console.log(c.dim(`  NOMARMY_MODEL_THINKING=${model.thinking}`));
      }
      if (!nonInteractive) {
        const answer = (await rl.question(c.bold("\nWrite this configuration? [y/N] "))).trim().toLowerCase();
        if (answer !== "y") { console.log(c.dim("Canceled; nothing written.")); return; }
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
      const searchedAlias = readEnvValue(commonPath, "NOMARMY_MODEL_ALIAS");
      if (searchedAlias) {
        writeEnvLine(commonPath, "NOMARMY_WORKER_MODEL", searchedAlias);
        writeEnvLine(commonPath, "NOMARMY_MODEL_THINKING", String(model.thinking));
      }
    }

    const installCmd = "nomarmy install";
    if (json) return out({ written: { profile: profilePath, common: model?.kind === "known" ? commonPath : null }, env: profileWrites, sizingTier, installCommand: installCmd });
    console.log(c.green(`\n✓ Wrote ${path.relative(nomarmyRoot, profilePath)}${model?.kind === "known" ? ` and ${path.relative(nomarmyRoot, commonPath)}` : ""}.`));
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
  const commonPath = path.join(nomarmyRoot, "config", "common.env");
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
      console.log(c.green("\n✓ Done") + " -- config/common.env was already updated by the search above.");
      alias = readEnvValue(commonPath, "NOMARMY_MODEL_ALIAS");
    } else {
      console.log(c.bold(`\nAbout to write ${path.relative(nomarmyRoot, commonPath)}:`));
      console.log(c.dim(`  NOMARMY_MODEL_REPO=${model.repo}\n  NOMARMY_MODEL_QUANT=${model.quant}\n  NOMARMY_MODEL_ALIAS=${model.alias}`));
      const answer = (await rl.question(c.bold("\nApply this model configuration? [y/N] "))).trim().toLowerCase();
      if (answer !== "y") { console.log(c.dim("Canceled; nothing changed.")); return; }
      writeEnvLine(commonPath, "NOMARMY_MODEL_REPO", model.repo);
      writeEnvLine(commonPath, "NOMARMY_MODEL_QUANT", model.quant);
      writeEnvLine(commonPath, "NOMARMY_MODEL_ALIAS", model.alias);
      console.log(c.green(`✓ Wrote ${path.relative(nomarmyRoot, commonPath)}.`));
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
    if (!(await confirm(rl, "Log in now?"))) return { ok: false };
    runInteractive(vendor.cli.bin, vendor.cli.loginArgs);
    status = readLoginStatus(vendorKey);
    if (!status.loggedIn) { console.log(c.red(`✗ Still not logged in to ${vendor.cli.bin}.`)); return { ok: false }; }
  }
  console.log(c.green(`✓ Logged in to ${vendor.cli.bin}${status.email ? ` as ${status.email}` : ""}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}.`));

  if (vendor.plugin) {
    step("OpenClaw plugin");
    const version = parseOpenclawVersion(runQuiet(openclawCmd(), ["--version"]).out);
    if (!versionAtLeast(version, vendor.plugin.minOpenclaw)) {
      console.log(c.yellow(`OpenClaw ${version ? version.join(".") : "(unknown version)"} is older than the ${vendor.plugin.minOpenclaw} this vendor's plugin needs.`));
      if (!(await confirm(rl, "Update OpenClaw now (npm update -g openclaw)?"))) return { ok: false };
      if (!runInteractive("npm", ["update", "-g", "openclaw"])) {
        console.log(c.red("✗ Update failed. If npm reports EACCES, your global npm directory has root-owned files from an old sudo install: `sudo chown -R $(whoami) ~/.npm ~/.npm-global` fixes it."));
        return { ok: false };
      }
    }
    if (!runQuiet(openclawCmd(), ["plugins", "inspect", vendor.plugin.id]).ok) {
      console.log(c.dim(`Installing ${vendor.plugin.spec}...`));
      if (!runInteractive(openclawCmd(), ["plugins", "install", vendor.plugin.spec])) {
        console.log(c.red(`✗ Plugin install failed. Run \`openclaw plugins install ${vendor.plugin.spec}\` yourself to see why.`));
        return { ok: false };
      }
      runQuiet(openclawCmd(), ["plugins", "registry", "--refresh"]);
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

function catalogModelsFor(provider) {
  return parseCatalogModels(runQuiet(openclawCmd(), ["models", "list", "--refresh"]).out, provider);
}

/** One real, one-token completion through OpenClaw -- the only proof a credential actually works. */
// Why the last probeWorker() call failed, in the vendor's words when it said.
let lastProbeFailure = null;
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
    const outcome = probeOutcome({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
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
 * session directly). Only ever run when a probe or catalog lookup has
 * already shown it's needed -- never preemptively.
 */
function openclawProviderLogin(vendor) {
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
// login -- and proves it with a real test call before saving. Changes apply
// to the next job; the MCP server re-reads the file when it changes.

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
      kind = AGENT_KINDS[Number((await rl.question(c.bold("Choice: "))).trim()) - 1];
      if (!kind) throw new Error("Not a valid choice.");
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
  const provider = API_PROVIDER_TYPES[Number((await rl.question(c.bold("Choice: "))).trim()) - 1];
  if (!provider) throw new Error("Not a valid choice.");
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

const SUBSCRIPTION_AGENT_DEFAULT_NAMES = { claude: "claude", codex: "codex", meta: "muse" };

async function addSubscriptionAgent(rl, agents) {
  console.log(c.dim("Connects ONE person's own subscription. Never pooled, never shared."));
  const vendorKeys = Object.keys(SUBSCRIPTION_VENDORS);
  let vendorKey = argv[3];
  if (!SUBSCRIPTION_VENDORS[vendorKey]) {
    console.log("\n" + c.bold("Which subscription?"));
    vendorKeys.forEach((k, i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${SUBSCRIPTION_VENDORS[k].label}`));
    vendorKey = vendorKeys[Number((await rl.question(c.bold("Choice: "))).trim()) - 1];
    if (!vendorKey) throw new Error(`Not a valid choice. Supported: ${vendorKeys.join(", ")}. DeepSeek and others without a plan are api agents.`);
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
  if (!auth.ok) { console.log(c.dim("\nStopped; nothing was written.")); return; }

  console.log(`\n${c.bold("→")} Models`);
  const needsOpenclawLogin = vendor.credential.kind === "openclaw-login";
  let linkedOpenclaw = false;
  let models = catalogModelsFor(vendor.provider);
  if (!models.length && needsOpenclawLogin) {
    linkedOpenclaw = openclawProviderLogin(vendor);
    models = catalogModelsFor(vendor.provider);
  }
  // The agent is the account; the model is only a default. Roles pick
  // their own model (or "auto" for the General to choose per job).
  if (models.length) models.forEach((m, i) => console.log(`  ${c.cyan(`${i + 1}.`)} ${m}`));
  else console.log(c.dim(`OpenClaw isn't listing ${vendor.provider} models yet.`));
  const pick = (await rl.question(c.bold(`Default model, optional${models.length ? " (a number or an id)" : ""}; blank = pick per role: `))).trim();
  const model = /^\d+$/.test(pick) && models.length ? models[Number(pick) - 1] : pick || null;
  if (pick && !model) throw new Error(`Not a valid choice: "${pick}".`);
  // The test call needs some model; it proves the login, not the choice.
  const probeModel = model ?? models[0] ?? vendor.defaultModel;

  const knownOwners = [...new Set(Object.values(agents).filter((a) => a.kind === "subscription").map((a) => a.owner))];
  const ownerDefault = auth.email ?? (knownOwners.length === 1 ? knownOwners[0] : "");
  const owner = (await rl.question(c.bold(`Whose subscription is this${ownerDefault ? ` [${ownerDefault}]` : ""}: `))).trim() || ownerDefault;
  if (!owner) throw new Error("An owner is required -- every job on this agent must name them in on_behalf_of.");

  const name = await askAgentName(rl, agents, SUBSCRIPTION_AGENT_DEFAULT_NAMES[vendorKey] ?? vendorKey);
  if (!name) { console.log(c.dim("Stopped; nothing was written.")); return; }

  console.log(`\n${c.bold("→")} Test call`);
  let works = probeModel ? probeWorker(vendor.provider, probeModel) : false;
  if (!works && needsOpenclawLogin && !linkedOpenclaw && probeModel) {
    openclawProviderLogin(vendor);
    works = probeWorker(vendor.provider, probeModel);
  }
  if (works) console.log(c.green(`✓ ${vendor.provider}/${probeModel} answered a real test prompt.`));
  else {
    console.log(c.red(probeModel ? `✗ A real test prompt to ${vendor.provider}/${probeModel} didn't come back.` : "✗ No model to make a test call with."));
    if (!(await confirm(rl, "Save the agent anyway?", { defaultYes: false }))) { console.log(c.dim("Stopped; nothing was written.")); return; }
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

// --- update ---

// Kind, provider and owner are fixed: changing any of them is a different
// agent (a different model family, vendor, or person's login), so that's
// `agents add`, not an edit. A subscription model change gets the same real
// test call `add` makes (interactive always; --json only with --probe,
// since it spends a real request on the subscription).
async function cmdAgentsUpdate() {
  const name = argv[2];
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
    probe = flag("probe") && current.kind === "subscription";
    if (!Object.keys(changes).length) throw new Error("Nothing to update -- pass at least one field flag (see `nomarmy agents update` usage).");
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

  if (probe && changes.model && !probeWorker(current.provider, changes.model)) {
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
  try { return execFileSync("git", args, { cwd: nomarmyRoot, encoding: "utf8" }).trim(); }
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
  // Installed from npm: there's no checkout to pull. npm updates the
  // package; connect resyncs the copy each coordinator runs.
  if (!fs.existsSync(path.join(nomarmyRoot, ".git"))) {
    const how = "npm install -g nomarmy@alpha && nomarmy connect";
    if (json) return out({ error: "installed from npm, not a git checkout", fix: how });
    console.log(`This nomArmy was installed from npm, so there's nothing to pull. Update with:\n  ${how}`);
    return;
  }
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
    if (json) return out({ updated: false, reason: "already up to date" });
    console.log(c.green("✓ Already up to date."));
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

  const resynced = [];
  const runInherit = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: json ? "ignore" : "inherit", ...opts });
  if (commandExists("claude")) {
    say("\nRe-syncing the Claude Code MCP install...");
    connectClaude({ nomarmyRoot, run: runInherit });
    resynced.push("claude");
  }
  if (commandExists("codex")) {
    say("\nRe-syncing the Codex MCP install...");
    connectCodex({ nomarmyRoot, run: runInherit });
    resynced.push("codex");
  }
  // Cursor has no CLI/PATH binary to probe with commandExists -- "already
  // connected" is read from its own config file instead.
  if (cursorAlreadyConnected()) {
    say("\nRe-syncing the Cursor MCP install...");
    connectCursor({ nomarmyRoot, run: runInherit });
    resynced.push("cursor");
  }

  if (json) return out({ updated: true, sha: git(["rev-parse", "HEAD"]), resynced });
  console.log(c.yellow("\nThe MCP server is a per-session child process: every open Claude Code / Codex / Cursor session needs a restart to pick this up, not just this one."));
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
  const requested = argv.slice(1).filter((a) => !a.startsWith("--"));
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
      const result = connectTarget(target, { nomarmyRoot, run });
      results.push({ target, connected: true, ...result });
      if (!json) console.log(c.green(`✓ Registered nomarmy-local-worker with ${target}.`));
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
  const repo = readEnvValue(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_MODEL_REPO");
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

function loadArmyForCli() {
  const agents = loadAgentsOrExit().agents;
  const loaded = loadArmy({ projectDir: repoDir });
  const usageSnapshots = readUsageSnapshots(process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents"));
  return { loaded, agents, summary: describeArmy(loaded, { agents, describeAgent: describeAgentLabel, usageSnapshots, agentProviderId }) };
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

async function cmdArmyShow() {
  const { summary } = loadArmyForCli();
  if (json) return out(summary);
  const g = summary.general;
  console.log(c.bold("🪖 nomArmy") + c.dim(`  (${repoDir})`));
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
  for (const layer of summary.layers) {
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

async function cmdArmyAssign() {
  // Positionals only: argv also holds flags, and `--json` must never be read as a model.
  const positional = argv.slice(2);
  const firstFlag = positional.findIndex((a) => a.startsWith("--"));
  const [roleName, agentName, model] = firstFlag === -1 ? positional : positional.slice(0, firstFlag);
  if (!roleName || !agentName) throw new Error("Usage: nomarmy army assign <role> <agent|none> [model|auto] [--global|--project|--local]");
  const layer = armyLayerFlag("global");
  const filePath = armyLayerPath(layer, { projectDir: repoDir });
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
  const agentName = argv[2];
  if (!agentName) throw new Error("Usage: nomarmy army general <agent> [--global|--local]");
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
  console.log(c.bold("\nArmy layers"));
  for (const a of army) console.log(`  ${a.exists ? c.green("●") : c.dim("○")} ${a.layer.padEnd(8)} ${c.dim(a.path)}`);
}

async function cmdConfig() {
  const sub = argv[1] ?? "paths";
  if (sub === "paths") return cmdConfigPaths();
  throw new Error(`Unknown config subcommand "${sub}". Use: nomarmy config paths`);
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

function collectJobs({ recent = 8 } = {}) {
  const root = jobsRootDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return { running: [], recent: [] }; }
  const jobs = names.map((name) => {
    const dir = path.join(root, name);
    const status = readJsonSafe(path.join(dir, "status.json")) ?? {};
    const meta = readJsonSafe(path.join(dir, "metadata.json"));
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
  }).sort((a, b) => b.started - a.started);
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
  const seen = new Map();
  const emit = (event, job, detail = "") => {
    if (json) console.log(JSON.stringify({ at: new Date().toISOString(), event, jobId: job.jobId, agent: job.agent, model: job.model, phase: job.phase, detail }));
    else console.log(`${new Date().toLocaleTimeString()}  ${event.padEnd(9)} ${job.jobId}  ${job.agent ?? "local"}${job.model ? `/${job.model}` : ""}${detail ? `  ${detail}` : ""}`);
  };
  process.on("SIGINT", () => process.exit(0));
  let first = true;
  for (;;) {
    const { running, recent } = collectJobs({ recent: 20 });
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
    seen.clear();
    for (const [id, j] of now) seen.set(id, j);
    first = false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Wait for one job in the shared, cross-session state directory. */
async function waitForJobCli() {
  const requested = value("wait");
  const jobId = requested ? path.basename(requested) : null;
  const timeoutSeconds = Number(value("timeout", "1800"));
  if (!jobId || jobId !== requested) {
    if (json) out({ error: "--wait needs a job id" });
    else console.error("nomarmy jobs: --wait needs a job id");
    process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    if (json) out({ error: "--timeout must be a non-negative number of seconds" });
    else console.error("nomarmy jobs: --timeout must be a non-negative number of seconds");
    process.exitCode = 2;
    return;
  }
  const jobDir = path.join(jobsRootDir(), jobId);
  const lease = path.join(agentStateRoot(), "leases", `${jobId}.json`);
  if (!fs.existsSync(jobDir) && !fs.existsSync(lease)) {
    if (json) out({ error: `unknown job id: ${jobId}` });
    else console.error(`nomarmy jobs: unknown job id: ${jobId}`);
    process.exitCode = 2;
    return;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
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
        commit: meta.commit?.sha ?? meta.commit ?? status.commit?.sha ?? status.commit ?? null,
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
      process.exitCode = result.coordinatorStatus === "complete" ? 0 : 1;
      return;
    }
    if (Date.now() >= deadline) {
      if (json) out({ error: `timed out waiting for job ${jobId}` });
      else console.error(`nomarmy jobs: timed out waiting for job ${jobId}`);
      process.exitCode = 2;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(1, deadline - Date.now()))));
  }
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

const commands = { scan: cmdScan, validate: cmdValidate, sizing: cmdSizing, init: cmdInit, setup: cmdSetup, install: cmdInstall, model: cmdModel, agents: cmdAgents, army: cmdArmy, jobs: cmdJobs, statusline: cmdStatusline, health: cmdHealth, config: cmdConfig, update: cmdUpdate, connect: cmdConnect, sandbox: cmdSandbox, start: cmdStart, stop: cmdStop, uninstall: cmdUninstall, help: () => usage(0) };
// doctor command
async function cmdDoctor() {
  // Import lazily to avoid circular dependencies
  const { runDoctor } = await import("../lib/doctor.mjs");
  await runDoctor({ json, exit: true, env: installEnv() });
}
commands.doctor = cmdDoctor;
if (!command || flag("help") || !commands[command]) usage(command && !commands[command] ? 2 : 0);

try {
  await commands[command]();
} catch (err) {
  if (json) out({ error: err.message });
  else console.error(`nomarmy ${command}: ${err.message}`);
  process.exit(1);
}
