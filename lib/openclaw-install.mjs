// One tested release for every nomArmy-managed OpenClaw installation.
// Never follow npm's dist-tag or downgrade a newer installation.
import { spawnSync } from "node:child_process";
import { SUBSCRIPTION_VENDORS, parseOpenclawVersion, versionAtLeast } from "./subscription-setup.mjs";

export const PINNED_OPENCLAW_VERSION = "2026.9.6";
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
    const { id, spec } = vendor.plugin;
    const inspected = run(command, ["plugins", "inspect", id, "--json"]);
    let plugin;
    try { plugin = parseCommandJson(inspected.stdout).plugin; } catch { /* Unverified output fails below. */ }
    const pluginVersion = plugin?.builtWithOpenClawVersion === undefined ? plugin?.version : plugin.builtWithOpenClawVersion;
    const installedVersion = have.join(".");
    const ok = inspected.ok && plugin?.enabled === true && pluginVersion !== undefined && versionAtLeast(have, pluginVersion);
    checks.push({
      id: `openclaw-plugin:${id}`, ok,
      message: ok ? `OpenClaw plugin ${id} ${pluginVersion} is ready (built for ${pluginVersion}; OpenClaw is ${installedVersion}).` : `OpenClaw plugin ${id} ${inspected.timedOut ? "check timed out." : plugin?.enabled === true && pluginVersion === undefined ? "version could not be verified." : `is missing, disabled, unreadable, or built for a newer OpenClaw than ${installedVersion}.`}`,
      fix: `openclaw plugins install ${spec}`,
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
  const actions = openclawInstallPlan(version.ok ? version.stdout : null, { prefix });
  print("Planned changes:");
  for (const action of actions) print(`  ${action.description}: ${action.command} ${action.args.join(" ")}`);
  if (!actions.length) print("  None. The installed OpenClaw is not older than the tested release.");
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
    return { ok: false, actions, changed, checks: [] };
  }
  for (const action of actions) {
    const result = run(action.command, action.args);
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
