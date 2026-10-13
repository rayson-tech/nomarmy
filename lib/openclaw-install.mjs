// One tested release for every nomArmy-managed OpenClaw installation.
// Never follow npm's dist-tag or downgrade a newer installation.
import { spawnSync } from "node:child_process";
import { SUBSCRIPTION_VENDORS, parseOpenclawVersion, pinnedPluginSpec, versionAtLeast } from "./subscription-setup.mjs";
import { PINNED_OPENCLAW_VERSION } from "./openclaw-pin.mjs";

export { PINNED_OPENCLAW_VERSION };
export const OPENCLAW_INSTALL_ARGS = Object.freeze(["install", "-g", `openclaw@${PINNED_OPENCLAW_VERSION}`]);

export function runOpenclawCommand(command, args, { timeoutMs = command === "npm" ? 600000 : 60000 } = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
  const timedOut = r.error?.code === "ETIMEDOUT";
  return { ok: !timedOut && r.status === 0, stdout: r.stdout ?? "",
    stderr: timedOut ? `Command timed out after ${timeoutMs} ms.` : r.stderr ?? "", timedOut };
}

export function openclawInstallPlan(installed, { prefix = null } = {}) {
  const have = parseOpenclawVersion(installed);
  if (versionAtLeast(have, PINNED_OPENCLAW_VERSION)) return [];
  return [{
    description: `${have ? "Upgrade" : "Install"} OpenClaw to ${PINNED_OPENCLAW_VERSION}`,
    command: "npm",
    args: [...OPENCLAW_INSTALL_ARGS, ...(prefix ? ["--prefix", prefix] : [])],
  }];
}

export function configuredSubscriptionVendors(agents = {}, extra = []) {
  return [...new Set([...extra, ...Object.values(agents)
    .filter((a) => a?.kind === "subscription")
    .map((a) => Object.keys(SUBSCRIPTION_VENDORS).find((key) => SUBSCRIPTION_VENDORS[key].provider === a.provider))])].filter(Boolean);
}

/**
 * A configured vendor's OpenClaw plugin -> { inspected, plugin, version }.
 * version is the OpenClaw release it was built for (or its own version).
 */
function inspectPlugin(run, command, id) {
  const inspected = run(command, ["plugins", "inspect", id, "--json"]);
  let plugin;
  try { plugin = parseCommandJson(inspected.stdout).plugin; } catch { /* Unverified output fails at the caller. */ }
  return { inspected, plugin, version: plugin?.builtWithOpenClawVersion === undefined ? plugin?.version : plugin.builtWithOpenClawVersion };
}

// OpenClaw's vendor plugins ship in step with OpenClaw, and model support
// lives in them: OpenClaw 2026.10.1 with the 2026.9.7 Codex plugin had its
// gpt-6.1-sol calls refused as "not supported when using Codex with a
// ChatGPT account", while the 2026.10.1 plugin runs them. So a configured
// vendor's plugin older than the tested release is updated with OpenClaw.
// To the tested release exactly, never ClawHub's latest: `plugins update`
// took codex to 2026.10.2, which refuses to load on OpenClaw 2026.10.1
// ("requires plugin API >=2026.10.2"). A reinstall at the pinned version
// (--force replaces the installed copy) is the only exact-version update.
function pluginBehindPin(version) {
  return parseOpenclawVersion(version) !== null && !versionAtLeast(parseOpenclawVersion(version), PINNED_OPENCLAW_VERSION);
}

/** `openclaw plugins install` args for a vendor plugin at the tested release. */
export function pluginInstallArgs(vendorPlugin, { replace = false } = {}) {
  return ["plugins", "install", pinnedPluginSpec(vendorPlugin), ...(replace ? ["--force"] : [])];
}

function installedAtPin(run, command, id) {
  const { inspected, version } = inspectPlugin(run, command, id);
  return inspected.ok && parseOpenclawVersion(version) !== null && !pluginBehindPin(version);
}

export function pluginUpdatePlan({ run = runOpenclawCommand, command = "openclaw", vendors = [] } = {}) {
  const actions = [];
  for (const key of [...new Set(vendors)]) {
    const vendorPlugin = SUBSCRIPTION_VENDORS[key]?.plugin;
    if (!vendorPlugin) continue;
    const { inspected, plugin, version } = inspectPlugin(run, command, vendorPlugin.id);
    if (inspected.ok && plugin?.enabled === true && pluginBehindPin(version)) {
      actions.push({ description: `Update OpenClaw plugin ${vendorPlugin.id} ${version} to ${PINNED_OPENCLAW_VERSION}`, command, args: pluginInstallArgs(vendorPlugin, { replace: true }), pluginId: vendorPlugin.id });
    } else if (!inspected.ok && /Plugin not found/i.test(`${inspected.stdout}\n${inspected.stderr}`)) {
      // A vendor in agents.yml whose plugin was never installed: a server
      // set up from a copied agents.yml rather than `agents add`.
      actions.push({ description: `Install OpenClaw plugin ${vendorPlugin.id} ${PINNED_OPENCLAW_VERSION}`, command, args: pluginInstallArgs(vendorPlugin), pluginId: vendorPlugin.id });
    }
  }
  return actions;
}

/** Read-only postflight using structured status and plugin compatibility data. */
function parseCommandJson(stdout) {
  const start = (stdout ?? "").indexOf("{");
  if (start < 0) throw new Error("No JSON object in command output");
  return JSON.parse(stdout.slice(start));
}

export function verifyOpenclaw({ run = runOpenclawCommand, command = "openclaw", vendors = [] } = {}) {
  const checks = [];
  const version = run(command, ["--version"]);
  const have = version.ok ? parseOpenclawVersion(version.stdout) : null;
  checks.push({
    id: "openclaw", ok: versionAtLeast(have, PINNED_OPENCLAW_VERSION),
    message: have ? `OpenClaw ${have.join(".")}${have.join(".") !== PINNED_OPENCLAW_VERSION && versionAtLeast(have, PINNED_OPENCLAW_VERSION) ? " is newer than the tested release; left unchanged" : ""}.` : version.timedOut ? "OpenClaw version check timed out." : "OpenClaw version could not be verified.",
    fix: `npm ${OPENCLAW_INSTALL_ARGS.join(" ")}`,
  });
  if (!have) return checks;
  for (const key of [...new Set(vendors)]) {
    const vendor = SUBSCRIPTION_VENDORS[key];
    if (!vendor) throw new Error(`Unknown subscription vendor: ${key}`);
    if (!vendor.plugin) continue;
    const { id } = vendor.plugin;
    const { inspected, plugin, version: pluginVersion } = inspectPlugin(run, command, id);
    const installedVersion = have.join(".");
    const behind = plugin?.enabled === true && pluginBehindPin(pluginVersion);
    const ok = inspected.ok && plugin?.enabled === true && pluginVersion !== undefined && versionAtLeast(have, pluginVersion) && !behind;
    checks.push({
      id: `openclaw-plugin:${id}`, ok,
      message: ok ? `OpenClaw plugin ${id} ${pluginVersion} is ready (built for ${pluginVersion}; OpenClaw is ${installedVersion}).` : `OpenClaw plugin ${id} ${inspected.timedOut ? "check timed out." : plugin?.enabled === true && pluginVersion === undefined ? "version could not be verified." : behind ? `${pluginVersion} is older than the tested release ${PINNED_OPENCLAW_VERSION}.` : `is missing, disabled, unreadable, or built for a newer OpenClaw than ${installedVersion}.`}`,
      fix: `openclaw ${pluginInstallArgs(vendor.plugin, { replace: true }).join(" ")}`,
    });
  }
  const status = run(command, ["update", "status", "--json"]);
  let warnings;
  try {
    if (!status.ok) throw new Error("Status command failed");
    const data = parseCommandJson(status.stdout);
    warnings = data.migrationWarnings === undefined ? [] : data.migrationWarnings;
    if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== "string")) throw new Error("Invalid migration warnings");
  } catch {
    checks.push({ id: "openclaw-migrations", ok: false, message: status.timedOut ? "OpenClaw migration check timed out." : "OpenClaw migrations could not be verified. Run openclaw update status --json by hand.", fix: "openclaw update status --json" });
    return checks;
  }
  checks.push({
    id: "openclaw-migrations", ok: warnings.length === 0,
    message: warnings.length ? warnings.join("\n") : "No pending OpenClaw migrations.",
    fix: "openclaw update repair",
  });
  return checks;
}

/** Print the complete mutation plan before a single default-no consent gate. */
export async function repairOpenclaw({
  run = runOpenclawCommand, command = "openclaw", vendors = [], prefix = null,
  yes = false, isTTY = false, ask = async () => "", print = console.log,
} = {}) {
  const version = run(command, ["--version"]);
  // Plugins are updated after OpenClaw itself, which their new release needs.
  const actions = [...openclawInstallPlan(version.ok ? version.stdout : null, { prefix }),
    ...(version.ok && parseOpenclawVersion(version.stdout) ? pluginUpdatePlan({ run, command, vendors }) : [])];
  print("Planned changes:");
  for (const action of actions) print(`  ${action.description}: ${action.command} ${action.args.join(" ")}`);
  if (!actions.length) print("  None. OpenClaw and every configured vendor's plugin are installed and at least the tested release.");
  print("Postflight checks (read-only):");
  print(`  ${command} --version`);
  for (const key of [...new Set(vendors)]) {
    const vendor = SUBSCRIPTION_VENDORS[key];
    if (!vendor) throw new Error(`Unknown subscription vendor: ${key}`);
    if (vendor.plugin) print(`  ${command} plugins inspect ${vendor.plugin.id} --json`);
  }
  print(`  ${command} update status --json`);
  print("  Migration repairs are not run automatically. If needed, run openclaw update repair --yes separately.");
  const changed = [];
  if (actions.length && !yes && (!isTTY || !/^(y|yes)$/i.test((await ask("Apply these changes? [y/N] ")).trim()))) {
    print(isTTY ? "No changes made." : "No changes made. Non-interactive repair requires --yes.");
    return { ok: false, declined: true, actions, changed, checks: [] };
  }
  for (const action of actions) {
    const result = run(action.command, action.args);
    if (!result.ok && action.pluginId && installedAtPin(run, action.command, action.pluginId)) {
      // Saved, but the running Gateway's hot reload lost a race ("config
      // reload superseded by a newer runtime config source"), seen live on
      // the codex 2026.10.2 install. OpenClaw's own fix is a reload.
      if (run(action.command, ["plugins", "reload", action.pluginId]).ok) { changed.push(action.description); continue; }
    }
    if (!result.ok) {
      print(`Failed: ${action.description}. Fix: ${action.command} ${action.args.join(" ")}`);
      print(`Completed changes: ${changed.length ? changed.join("; ") : "none"}. The failed install may have partially modified OpenClaw.`);
      return { ok: false, actions, changed, checks: [] };
    }
    changed.push(action.description);
  }
  print(`Changed: ${changed.length ? changed.join("; ") : "nothing"}.`);
  const checks = verifyOpenclaw({ run, command, vendors });
  for (const check of checks) print(`${check.ok ? "OK" : "FAIL"}: ${check.message}${check.ok ? "" : ` Fix: ${check.fix}`}`);
  return { ok: checks.every((check) => check.ok), actions, changed, checks };
}
