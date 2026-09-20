#!/usr/bin/env node
// nomArmy CLI. Every command proposes before it writes anything -- init,
// setup, model and update all show exactly what would change and write only
// after explicit confirmation ([y/N]) or an explicit non-interactive flag
// (--write, --json with the required choices given up front). Nothing here
// provisions SYSTEM-level infrastructure on its own: install.sh (builds
// llama.cpp, installs OpenClaw, configures the sandbox) stays a separate,
// manual step in every case, printed but never run.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, validateConfig, stringifyConfig, findConfigFile, CONFIG_FILENAMES } from "../lib/config.mjs";
import { scanRepository, compareEvidence } from "../lib/scan.mjs";
import { buildConfigProposal } from "../lib/propose.mjs";
import { detectHardware } from "../lib/hardware.mjs";
import { readGGUFMetadata, resolveModelPath, totalSplitBytes } from "../lib/gguf.mjs";
import { recommend, evaluateConfig, bytesPerKvElementForCacheTypes } from "../lib/sizing.mjs";
import { connectClaude, connectCodex, connectCursor, cursorAlreadyConnected } from "../lib/connect.mjs";

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
  setup           Detect this machine, recommend a profile (offering "more
                  noms" vs "nominal" when they differ), choose a model, and
                  write config/profiles/<name>.env (+ config/common.env).
                  Prints the install.sh command; never runs it.
                  --tier <more|nominal>   with --json, skip the prompt
  model           Change the configured model later, without the rest of
                  setup's questions.
  update          Pull the latest nomArmy code and re-sync the installed
                  MCP copy (fast-forward only; refuses on local changes).
  connect [claude] [codex] [cursor]
                  (Re-)register the MCP server with one or more coordinators.
                  With no target and not --json, prompts an interactive
                  multi-select instead.
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
                  --check   evaluate the loaded profile instead of recommending
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
    if (answer !== "y") { console.log(c.dim("Cancelled; nothing written.")); return; }
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

// gpt-oss-20b is NOT a second curated entry here, on purpose: it's real (the
// README's own benchmark ran it), but NOMARMY_WORKER_MODEL_FALLBACK (its only
// reference anywhere in this codebase) is a separate routing identity for
// profile: "gpt" job dispatch, not a GGUF repo/quant this command could point
// NOMARMY_MODEL_REPO/QUANT at -- no verified repo string for it exists in this
// project's history, and fabricating one here would be worse than not
// offering it. Confirmed by grepping every config file and git history.
const KNOWN_MODELS = {
  default: { label: "Qwen3-Coder-Next (shipped default, coding-specialized)", repo: "Qwen/Qwen3-Coder-Next-GGUF", quant: "Q4_K_M", alias: "qwen3-coder-next" },
};

/**
 * The one model-choice menu both `setup` and `model` show. Returns
 * `{ kind: "known", repo, quant, alias }` for the curated default, or
 * `{ kind: "search" }` once scripts/select-model.mjs (spawned as a child
 * process, not reimplemented -- it already owns the Hugging Face search,
 * confirm and write flow) has finished.
 */
async function chooseModel(rl) {
  console.log("\n" + c.bold("Which model?"));
  console.log(`  ${c.cyan("1.")} ${KNOWN_MODELS.default.label}`);
  console.log(`  ${c.cyan("2.")} Search Hugging Face for something else`);
  const choice = (await rl.question(c.bold("Choice [1]: "))).trim() || "1";
  if (choice === "2") {
    const term = (await rl.question("Search term (or owner/model-GGUF repo): ")).trim();
    if (!term) throw new Error("A search term or repo is required for the Hugging Face search path.");
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(nomarmyRoot, "scripts", "select-model.mjs"), term], { stdio: "inherit" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`select-model.mjs exited ${code}`))));
      child.on("error", reject);
    });
    return { kind: "search" };
  }
  return { kind: "known", ...KNOWN_MODELS.default };
}

/**
 * `nomarmy setup`: detect hardware, recommend a profile the same way
 * `nomarmy sizing` already does, let the user pick a model, then write the
 * result to config/profiles/<name>.env and (for the two curated model
 * choices) config/common.env. Stops there -- prints the exact `install.sh`
 * command rather than running it. install.sh builds llama.cpp, curl-pipes an
 * installer and touches sandbox/provider config; that is not a proportionate
 * thing for an opt-in flag on a CLI whose whole brand is "reports or
 * proposes" to cross, unlike the cheap, reversible, single-file writes this
 * command itself does.
 */
async function cmdSetup() {
  const execution = value("execution", process.env.NOMARMY_EXECUTION || "local");
  const isCloud = execution !== "local";
  const hardware = isCloud ? null : await detectHardware();
  const modelPath = isCloud ? null : findModel();
  const gguf = modelPath ? await readGGUFMetadata(modelPath) : { found: false };
  const res = recommend({ hardware, gguf, execution });

  const nonInteractive = json;
  if (nonInteractive && !flag("profile-name")) throw new Error("--json requires --profile-name <name>.");
  if (nonInteractive && !isCloud && !flag("model")) throw new Error("--json requires --model default for a local profile (Hugging Face search is interactive-only).");

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
        if (!KNOWN_MODELS[which]) throw new Error(`--model must be "default" under --json, got "${which}".`);
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
      }
      if (!nonInteractive) {
        const answer = (await rl.question(c.bold("\nWrite this configuration? [y/N] "))).trim().toLowerCase();
        if (answer !== "y") { console.log(c.dim("Cancelled; nothing written.")); return; }
      }
    }

    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    for (const [k, v] of Object.entries(profileWrites)) writeEnvLine(profilePath, k, v);
    if (model?.kind === "known" && model.repo) {
      writeEnvLine(commonPath, "NOMARMY_MODEL_REPO", model.repo);
      writeEnvLine(commonPath, "NOMARMY_MODEL_QUANT", model.quant);
    }
    if (model?.kind === "known") writeEnvLine(commonPath, "NOMARMY_MODEL_ALIAS", model.alias);

    const installCmd = `./install.sh --profile ${profileName}${isCloud ? "" : ""}`;
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
async function cmdModel() {
  if (json) {
    const which = value("model");
    if (!KNOWN_MODELS[which]) throw new Error('--json requires --model default (Hugging Face search is interactive-only).');
    const m = KNOWN_MODELS[which];
    const commonPath = path.join(nomarmyRoot, "config", "common.env");
    if (m.repo) { writeEnvLine(commonPath, "NOMARMY_MODEL_REPO", m.repo); writeEnvLine(commonPath, "NOMARMY_MODEL_QUANT", m.quant); }
    writeEnvLine(commonPath, "NOMARMY_MODEL_ALIAS", m.alias);
    return out({ written: commonPath, model: m });
  }
  if (!process.stdin.isTTY) throw new Error("nomarmy model needs an interactive terminal, or --json --model default.");
  const rl = createInterface({ input, output });
  try {
    console.log(c.bold("🍪 nomArmy model"));
    const model = await chooseModel(rl);
    if (model.kind === "search") { console.log(c.green("\n✓ Done") + " -- config/common.env was already updated by the search above."); }
    else {
      const commonPath = path.join(nomarmyRoot, "config", "common.env");
      console.log(c.bold(`\nAbout to write ${path.relative(nomarmyRoot, commonPath)}:`));
      console.log(c.dim(`  NOMARMY_MODEL_REPO=${model.repo}\n  NOMARMY_MODEL_QUANT=${model.quant}\n  NOMARMY_MODEL_ALIAS=${model.alias}`));
      const answer = (await rl.question(c.bold("\nApply this model configuration? [y/N] "))).trim().toLowerCase();
      if (answer !== "y") { console.log(c.dim("Cancelled; nothing changed.")); return; }
      writeEnvLine(commonPath, "NOMARMY_MODEL_REPO", model.repo);
      writeEnvLine(commonPath, "NOMARMY_MODEL_QUANT", model.quant);
      writeEnvLine(commonPath, "NOMARMY_MODEL_ALIAS", model.alias);
      console.log(c.green(`✓ Wrote ${path.relative(nomarmyRoot, commonPath)}.`));
    }
    console.log(c.dim("\nRestart inference to pick this up:\n  ./scripts/stop-inference.sh\n  ./scripts/start-inference.sh <profile>"));
  } finally {
    rl.close();
  }
}

function git(args) {
  try { return execFileSync("git", args, { cwd: nomarmyRoot, encoding: "utf8" }).trim(); }
  catch (error) { throw new Error(`git ${args.join(" ")} failed: ${error.stderr ? String(error.stderr).trim() : error.message}`); }
}

/**
 * `nomarmy update`: pull and apply the latest nomArmy code -- NOT a model
 * swap, see `nomarmy model` for that. Real motivation: the MCP server Claude
 * Code actually runs is a COPY (scripts/setup-claude-worker.sh copies
 * mcp/server.mjs + lib/ + package.json into
 * ~/.local/share/nomarmy-local-worker and registers that path), not this
 * checkout -- a bare `git pull` here changes nothing Claude Code is running
 * until that copy step reruns.
 */
async function cmdUpdate() {
  const say = (s) => { if (!json) console.log(s); };
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

  console.log(`Hardware: ${hardware.platform}/${hardware.arch}`
    + `, ${hardware.cpu?.logicalCores ?? "?"} logical cores`
    + `, ${gib(hardware.memory?.totalBytes)} RAM`
    + (hardware.gpu?.count ? `, ${hardware.gpu.count} GPU` : ", no NVIDIA GPU"));
  console.log(`Model: ${gguf.found
    ? `${path.basename(gguf.path)} (${gib(gguf.fileSizeBytes)})`
    : "not found - using assumed architecture"}`);

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

const commands = { scan: cmdScan, validate: cmdValidate, sizing: cmdSizing, init: cmdInit, setup: cmdSetup, model: cmdModel, update: cmdUpdate, connect: cmdConnect, start: cmdStart, stop: cmdStop, uninstall: cmdUninstall, help: () => usage(0) };
// doctor command
async function cmdDoctor() {
  // Import lazily to avoid circular dependencies
  const { runDoctor } = await import("../lib/doctor.mjs");
  await runDoctor({ json, exit: true });
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
