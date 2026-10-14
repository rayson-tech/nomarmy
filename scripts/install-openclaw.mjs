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
import { configuredSubscriptionVendors, openclawInstallPlan, pluginUpdatePlan, runOpenclawCommand, PINNED_OPENCLAW_VERSION } from "../lib/openclaw-install.mjs";
import { openclawChannel, resolveOpenclawTarget, skippedReleases, upgradeOpenclaw, modelsToCheck } from "../lib/openclaw-channel.mjs";
import { probeModel } from "../lib/model-probe.mjs";
import { agentProviderId } from "../lib/agents.mjs";
import { loadArmy, describeArmy } from "../lib/army.mjs";
import { refreshProviderConfigs } from "../lib/openclaw-config.mjs";
import { SUBSCRIPTION_VENDORS } from "../lib/subscription-setup.mjs";

const update = process.argv.includes("--update");
ensureOpenClawOnPath();
const command = process.env.NOMARMY_OPENCLAW_CMD || "openclaw";
const version = runOpenclawCommand(command, ["--version"]);
const agents = loadAgents(globalConfigDir()).agents;
const vendors = configuredSubscriptionVendors(agents);
// `openclaw: latest` in limits.yml follows npm's latest instead of the pin.
const channel = openclawChannel();
const stateRoot = process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents");
const skipFile = path.join(stateRoot, "openclaw-skipped.json");
const installed = version.ok ? version.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
const { target } = resolveOpenclawTarget(channel, { skipped: skippedReleases(skipFile), installed });
const needed = openclawInstallPlan(version.ok ? version.stdout : null, { target }).length > 0;
const pluginsBehind = !needed && version.ok && pluginUpdatePlan({ command, vendors, target }).length > 0;
const [major, minor] = process.versions.node.split(".").map(Number);
if (update && !needed && !pluginsBehind) {
  process.exitCode = 0;
} else if (needed && !((major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26)) {
  console.error(`OpenClaw ${target} needs Node 24.16+ or 26.1+. Upgrade Node first.`);
  process.exitCode = 1;
} else {
  const prefixIndex = process.argv.indexOf("--prefix");
  const prefix = prefixIndex >= 0 ? process.argv[prefixIndex + 1] : update ? userPrefixUnlessGlobalWritable() : null;
  const isTTY = update && Boolean(process.stdin.isTTY);
  const rl = isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const wanted = channel === "latest" ? `follows npm's latest OpenClaw, ${target} (tested with ${PINNED_OPENCLAW_VERSION})` : `is tested with OpenClaw ${PINNED_OPENCLAW_VERSION}`;
    if (update) console.log(needed ? `\nnomArmy ${wanted}; this machine has ${version.ok ? version.stdout.trim() : "no working OpenClaw"}.`
      : `\nnomArmy ${wanted}, and some of its vendor plugins here are older.`);
    let roles = {};
    try { roles = describeArmy(loadArmy({ projectDir: process.cwd() }), { agents }).roles ?? {}; } catch { /* no army: agents' defaults only */ }
    const result = await upgradeOpenclaw({
      channel, command, prefix, yes: !update || process.argv.includes("--yes"), isTTY,
      ask: (prompt) => rl.question(prompt),
      vendors, skipFile,
      models: modelsToCheck({ agents, roles, providerOf: agentProviderId }),
      probe: ({ provider, model }) => probeModel({ provider, model, stateRoot, openclawCmd: command }),
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
