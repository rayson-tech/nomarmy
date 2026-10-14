// install.sh has already installed nomArmy's dependencies. Nothing is ready
// until the configured vendors and read-only OpenClaw diagnostics pass.
//
// --update (from `nomarmy update`, run from the freshly updated code so the
// pin is the new release's): silent when OpenClaw and every configured
// vendor's plugin are at or past the pin; otherwise asks first, or applies
// with --yes. Exit 2 when it made no change because nobody said yes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadAgents } from "../lib/agents.mjs";
import { globalConfigDir } from "../lib/army.mjs";
import { ensureOpenClawOnPath } from "../lib/openclaw-path.mjs";
import { configuredSubscriptionVendors, openclawInstallPlan, pluginUpdatePlan, repairOpenclaw, runOpenclawCommand, PINNED_OPENCLAW_VERSION } from "../lib/openclaw-install.mjs";
import { refreshProviderConfigs } from "../lib/openclaw-config.mjs";
import { SUBSCRIPTION_VENDORS } from "../lib/subscription-setup.mjs";

const update = process.argv.includes("--update");
ensureOpenClawOnPath();
const command = process.env.NOMARMY_OPENCLAW_CMD || "openclaw";
const version = runOpenclawCommand(command, ["--version"]);
const vendors = configuredSubscriptionVendors(loadAgents(globalConfigDir()).agents);
const needed = openclawInstallPlan(version.ok ? version.stdout : null).length > 0;
const pluginsBehind = !needed && version.ok && pluginUpdatePlan({ command, vendors }).length > 0;
const [major, minor] = process.versions.node.split(".").map(Number);
if (update && !needed && !pluginsBehind) {
  process.exitCode = 0;
} else if (needed && !((major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26)) {
  console.error(`OpenClaw ${PINNED_OPENCLAW_VERSION} needs Node 24.16+ or 26.1+. Upgrade Node first.`);
  process.exitCode = 1;
} else {
  const prefixIndex = process.argv.indexOf("--prefix");
  const prefix = prefixIndex >= 0 ? process.argv[prefixIndex + 1] : update ? userPrefixUnlessGlobalWritable() : null;
  const isTTY = update && Boolean(process.stdin.isTTY);
  const rl = isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (update) console.log(needed ? `\nnomArmy is tested with OpenClaw ${PINNED_OPENCLAW_VERSION}; this machine has ${version.ok ? version.stdout.trim() : "no working OpenClaw"}.`
      : `\nnomArmy is tested with OpenClaw ${PINNED_OPENCLAW_VERSION}, and some of its vendor plugins here are older.`);
    const result = await repairOpenclaw({
      command, prefix, yes: !update || process.argv.includes("--yes"), isTTY,
      ask: (prompt) => rl.question(prompt),
      vendors,
    });
    process.exitCode = result.ok ? 0 : result.declined ? 2 : 1;
  } finally {
    rl?.close();
  }
}

// A plugin updated here or by hand lists models its provider entry predates
// (Meta's 2026.10.3 added muse-wonder-1.0); add them so they aren't "Unknown model".
if (process.exitCode === 0) {
  for (const result of await refreshProviderConfigs(vendors.map((key) => SUBSCRIPTION_VENDORS[key]))) {
    if (result.added?.length) console.log(`Added ${result.added.join(", ")} to OpenClaw's ${result.provider} provider (backup: ${result.backup}).`);
    else if (result.changed) console.log(`Added the ${result.provider} provider to OpenClaw's config (backup: ${result.backup}).`);
    else if (result.error) console.log(`Couldn't refresh OpenClaw's ${result.provider} provider: ${result.error}`);
  }
}

// install.sh's rule: npm's global prefix when it's writable, else ~/.npm-global.
function userPrefixUnlessGlobalWritable() {
  const global = runOpenclawCommand("npm", ["prefix", "-g"]);
  const dir = global.ok ? global.stdout.trim() : "";
  try { if (dir) { fs.accessSync(dir, fs.constants.W_OK); return null; } } catch { /* not writable */ }
  return path.join(os.homedir(), ".npm-global");
}
