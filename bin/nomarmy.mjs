#!/usr/bin/env node
// nomArmy CLI. Everything here reports or proposes; nothing here provisions
// infrastructure or rewrites configuration on its own. A human applies changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateConfig, CONFIG_FILENAMES } from "../lib/config.mjs";
import { scanRepository, compareEvidence } from "../lib/scan.mjs";
import { detectHardware } from "../lib/hardware.mjs";
import { readGGUFMetadata } from "../lib/gguf.mjs";
import { recommend, evaluateConfig } from "../lib/sizing.mjs";

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

function usage(code = 0) {
  console.log(`nomArmy - bounded coding workers with independently verified results

Usage: nomarmy <command> [options]

  scan            Inspect this repository and report its execution environment.
                  --check   compare the evidence against a committed .nomarmy.yml
  validate        Validate .nomarmy.yml against the schema.
  sizing          Recommend context and nom count for this machine.
                  --check   evaluate the loaded profile instead of recommending
  doctor          Check this host is ready to run nomArmy, with a fix for
                  anything missing.
  help

Options:
  --repo <dir>    repository to inspect (default: cwd)
  --json          machine-readable output
  --model <path>  GGUF file to size against (default: auto-discover)
  --execution <m> local | bedrock (default: $NOMARMY_EXECUTION or local)
`);
  process.exit(code);
}

// llama.cpp caches Hugging Face pulls; check the usual places rather than
// making the user pass --model. Absence is normal on a fresh install.
function findModel() {
  const explicit = value("model");
  if (explicit) return explicit;
  const installRoot = process.env.NOMARMY_INSTALL_ROOT
    || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents");
  const roots = [
    process.env.NOMARMY_MODEL_PATH,
    path.join(os.homedir(), ".cache", "llama.cpp"),
    path.join(installRoot, "models"),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      if (fs.statSync(root).isFile()) {
        if (root.endsWith(".gguf")) return root;
        continue;
      }
      const hit = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".gguf"))
        .sort((a, b) => b.name.localeCompare(a.name))[0];
      if (hit) return path.join(root, hit.name);
    } catch {
      // An unreadable cache directory is a normal outcome, not an error.
    }
  }
  return null;
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

async function cmdSizing() {
  const execution = value("execution", process.env.NOMARMY_EXECUTION || "local");
  const hardware = await detectHardware();
  const modelPath = findModel();
  const gguf = modelPath ? await readGGUFMetadata(modelPath) : { found: false };

  if (flag("check")) return sizingCheck(hardware, gguf);

  const res = recommend({ hardware, gguf, execution });
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
  const doesNotFit = res.memory && res.memory.fits === false;
  console.log(doesNotFit
    ? `\nNOTHING FITS on this machine. Closest fallback (confidence: ${res.confidence}):\n`
    : `\nRecommended (confidence: ${res.confidence}):\n`);
  for (const [k, v] of Object.entries(res.env ?? {})) console.log(`  ${k}=${v}`);
  console.log(`\n  ${res.maxWorkers} nom(s) at ${K(res.contextPerNom)} each`
    + (res.contextTotal ? `  (${res.contextTotal} total across ${res.llamaParallel} slot(s))` : ""));
  if (res.limitedBy) console.log(`  limited by: ${res.limitedBy}`);

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

const commands = { scan: cmdScan, validate: cmdValidate, sizing: cmdSizing, help: () => usage(0) };
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
