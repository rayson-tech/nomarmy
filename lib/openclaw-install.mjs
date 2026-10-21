// The OpenClaw release every nomArmy-managed installation runs: the tested
// pin by default, or npm's latest when the operator chose `openclaw: latest`
// (lib/openclaw-channel.mjs), never below the pin. Vendor plugins follow the
// same version. Never downgrade a newer installation, except to roll back.
import { spawnSync } from "node:child_process";
import { SUBSCRIPTION_VENDORS, parseOpenclawVersion, pinnedPluginSpec, versionAtLeast } from "./subscription-setup.mjs";
import { PINNED_OPENCLAW_VERSION } from "./openclaw-pin.mjs";
import fs from "node:fs";
import path from "node:path";
import { openclawHome } from "./openclaw-config.mjs";

export { PINNED_OPENCLAW_VERSION };
export const OPENCLAW_INSTALL_ARGS = Object.freeze(["install", "-g", `openclaw@${PINNED_OPENCLAW_VERSION}`]);
const installArgs = (target) => ["install", "-g", `openclaw@${target}`];

export function runOpenclawCommand(command, args, { timeoutMs = command === "npm" ? 600000 : 60000 } = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
  const timedOut = r.error?.code === "ETIMEDOUT";
  return { ok: !timedOut && r.status === 0, stdout: r.stdout ?? "",
    stderr: timedOut ? `Command timed out after ${timeoutMs} ms.` : r.stderr ?? "", timedOut };
}

/** exact: install `target` even over a newer release (a rollback). */
export function openclawInstallPlan(installed, { prefix = null, target = PINNED_OPENCLAW_VERSION, exact = false } = {}) {
  const have = parseOpenclawVersion(installed);
  if (exact ? have?.join(".") === target : versionAtLeast(have, target)) return [];
  return [{
    description: `${!have ? "Install" : exact && versionAtLeast(have, target) ? "Roll back" : "Upgrade"} OpenClaw to ${target}`,
    command: "npm",
    args: [...installArgs(target), ...(prefix ? ["--prefix", prefix] : [])],
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
function pluginBehind(version, target = PINNED_OPENCLAW_VERSION) {
  return parseOpenclawVersion(version) !== null && !versionAtLeast(parseOpenclawVersion(version), target);
}

/** `openclaw plugins install` args for a vendor plugin at the target release (the tested one by default). */
export function pluginInstallArgs(vendorPlugin, { replace = false, version = PINNED_OPENCLAW_VERSION } = {}) {
  return ["plugins", "install", pinnedPluginSpec(vendorPlugin, version), ...(replace ? ["--force"] : [])];
}

function installedAtTarget(run, command, id, target) {
  const { inspected, version } = inspectPlugin(run, command, id);
  return inspected.ok && parseOpenclawVersion(version) !== null && !pluginBehind(version, target);
}

/** exact: reinstall any plugin not at `target` exactly (a rollback). */
export function pluginUpdatePlan({ run = runOpenclawCommand, command = "openclaw", vendors = [], target = PINNED_OPENCLAW_VERSION, exact = false } = {}) {
  const actions = [];
  for (const key of [...new Set(vendors)]) {
    const vendorPlugin = SUBSCRIPTION_VENDORS[key]?.plugin;
    if (!vendorPlugin) continue;
    const { inspected, plugin, version } = inspectPlugin(run, command, vendorPlugin.id);
    const off = exact ? parseOpenclawVersion(version)?.join(".") !== target : pluginBehind(version, target);
    if (inspected.ok && plugin?.enabled === true && off) {
      actions.push({ description: `${exact && !pluginBehind(version, target) ? "Roll back" : "Update"} OpenClaw plugin ${vendorPlugin.id} ${version} to ${target}`, command, args: pluginInstallArgs(vendorPlugin, { replace: true, version: target }), pluginId: vendorPlugin.id });
    } else if (!inspected.ok && /Plugin not found/i.test(`${inspected.stdout}\n${inspected.stderr}`)) {
      // A vendor in agents.yml whose plugin was never installed: a server
      // set up from a copied agents.yml rather than `agents add`.
      actions.push({ description: `Install OpenClaw plugin ${vendorPlugin.id} ${target}`, command, args: pluginInstallArgs(vendorPlugin, { version: target }), pluginId: vendorPlugin.id });
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

/**
 * The Codex plugin runs its bundled `@openai/codex`, whose binary is one
 * optional dependency per platform (@openai/codex-darwin-arm64, ...). npm
 * can skip optional dependencies (omit=optional, a lockfile made on another
 * platform), and then Codex can't start. Null when there's nothing to judge:
 * no plugin at the usual place, or no bundled @openai/codex.
 */
export function codexBinaryCheck({ home = openclawHome(), platform = process.platform, arch = process.arch } = {}) {
  const modules = path.join(home, "extensions", "codex", "node_modules", "@openai");
  let version;
  try { version = JSON.parse(fs.readFileSync(path.join(modules, "codex", "package.json"), "utf8")).version; } catch { return null; }
  const binary = `@openai/codex-${platform}-${arch}`;
  const ok = fs.existsSync(path.join(modules, `codex-${platform}-${arch}`));
  return { id: "openclaw-plugin:codex-binary", ok,
    message: ok ? `Codex plugin has its ${platform}-${arch} binary.` : `OpenClaw's Codex plugin is missing ${binary}, so its bundled Codex can't start (npm skipped an optional dependency).`,
    // Installed beside it and copied in: npm refuses to install inside the
    // plugin itself, whose package.json has workspace: references.
    fix: `d=$(mktemp -d) && npm install --prefix "$d" --no-save ${binary}@npm:@openai/codex@${version}-${platform}-${arch} && cp -R "$d/node_modules/${binary}" "${modules}/" && rm -rf "$d"` };
}

export function verifyOpenclaw({ run = runOpenclawCommand, command = "openclaw", vendors = [], target = PINNED_OPENCLAW_VERSION, codexBinary = codexBinaryCheck } = {}) {
  const checks = [];
  const version = run(command, ["--version"]);
  const have = version.ok ? parseOpenclawVersion(version.stdout) : null;
  checks.push({
    id: "openclaw", ok: versionAtLeast(have, PINNED_OPENCLAW_VERSION),
    message: have ? `OpenClaw ${have.join(".")}${have.join(".") !== PINNED_OPENCLAW_VERSION && versionAtLeast(have, PINNED_OPENCLAW_VERSION) ? " is newer than the tested release; left unchanged" : ""}.` : version.timedOut ? "OpenClaw version check timed out." : "OpenClaw version could not be verified.",
    fix: `npm ${installArgs(target).join(" ")}`,
  });
  if (!have) return checks;
  for (const key of [...new Set(vendors)]) {
    const vendor = SUBSCRIPTION_VENDORS[key];
    if (!vendor) throw new Error(`Unknown subscription vendor: ${key}`);
    if (!vendor.plugin) continue;
    const { id } = vendor.plugin;
    const { inspected, plugin, version: pluginVersion } = inspectPlugin(run, command, id);
    const installedVersion = have.join(".");
    const behind = plugin?.enabled === true && pluginBehind(pluginVersion);
    const ok = inspected.ok && plugin?.enabled === true && pluginVersion !== undefined && versionAtLeast(have, pluginVersion) && !behind;
    checks.push({
      id: `openclaw-plugin:${id}`, ok,
      message: ok ? `OpenClaw plugin ${id} ${pluginVersion} is ready (built for ${pluginVersion}; OpenClaw is ${installedVersion}).` : `OpenClaw plugin ${id} ${inspected.timedOut ? "check timed out." : plugin?.enabled === true && pluginVersion === undefined ? "version could not be verified." : behind ? `${pluginVersion} is older than the tested release ${PINNED_OPENCLAW_VERSION}.` : `is missing, disabled, unreadable, or built for a newer OpenClaw than ${installedVersion}.`}`,
      fix: `openclaw ${pluginInstallArgs(vendor.plugin, { replace: true, version: target }).join(" ")}`,
    });
    if (key === "codex" && ok) { const binary = codexBinary(); if (binary) checks.push(binary); }
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
/** The last lines a failed command printed: why it failed, which the "Fix:" line alone never said. */
export function failureTail(result, lines = 12) {
  const text = [result?.stderr, result?.stdout].map((part) => String(part ?? "").trim()).filter(Boolean).join("\n");
  return text ? text.split(/\r?\n/).slice(-lines).join("\n") : "";
}

export async function repairOpenclaw({
  run = runOpenclawCommand, command = "openclaw", vendors = [], prefix = null,
  yes = false, isTTY = false, ask = async () => "", print = console.log,
  target = PINNED_OPENCLAW_VERSION, exact = false,
} = {}) {
  const version = run(command, ["--version"]);
  // Plugins are updated after OpenClaw itself, which their new release needs.
  const install = openclawInstallPlan(version.ok ? version.stdout : null, { prefix, target, exact });
  const actions = [...install,
    ...(version.ok && parseOpenclawVersion(version.stdout) ? pluginUpdatePlan({ run, command, vendors, target, exact }) : [])];
  // An upgrade leaves existing state on the old schema: OpenClaw 2026.10.3
  // refused auth writes ("uses schema version 23; ... run openclaw doctor
  // --fix") until Doctor migrated it. Last, so it also finishes plugin
  // upgrades. --non-interactive limits it to safe migrations.
  if (install.some((action) => action.description.startsWith("Upgrade "))) {
    actions.push({ description: "Migrate OpenClaw's state to the new release", command, args: ["doctor", "--fix", "--non-interactive"], timeoutMs: 300000 });
  }
  print("Planned changes:");
  for (const action of actions) print(`  ${action.description}: ${action.command} ${action.args.join(" ")}`);
  if (!actions.length) print(`  None. OpenClaw and every configured vendor's plugin are installed and ${exact ? `at ${target}` : target === PINNED_OPENCLAW_VERSION ? "at least the tested release" : `at least ${target}`}.`);
  print("Postflight checks (read-only):");
  print(`  ${command} --version`);
  for (const key of [...new Set(vendors)]) {
    const vendor = SUBSCRIPTION_VENDORS[key];
    if (!vendor) throw new Error(`Unknown subscription vendor: ${key}`);
    if (vendor.plugin) print(`  ${command} plugins inspect ${vendor.plugin.id} --json`);
  }
  print(`  ${command} update status --json`);
  if (!actions.some((action) => action.args[0] === "doctor")) print("  Migration repairs are not run automatically. If needed, run openclaw update repair --yes separately.");
  const changed = [];
  if (actions.length && !yes && (!isTTY || !/^(y|yes)$/i.test((await ask("Apply these changes? [y/N] ")).trim()))) {
    print(isTTY ? "No changes made." : "No changes made. Non-interactive repair requires --yes.");
    return { ok: false, declined: true, actions, changed, checks: [] };
  }
  const attempt = (action) => action.timeoutMs ? run(action.command, action.args, { timeoutMs: action.timeoutMs }) : run(action.command, action.args);
  for (const action of actions) {
    let result = attempt(action);
    if (!result.ok && action.pluginId && installedAtTarget(run, action.command, action.pluginId, target)) {
      // Saved, but the running Gateway's hot reload lost a race ("config
      // reload superseded by a newer runtime config source"), seen live on
      // the codex 2026.10.2 install. OpenClaw's own fix is a reload.
      if (run(action.command, ["plugins", "reload", action.pluginId]).ok) { changed.push(action.description); continue; }
    }
    // A plugin install right after OpenClaw itself was replaced failed once
    // and passed when run again by hand (codex 2026.10.5); retry once.
    if (!result.ok) {
      print(`${action.description} failed; trying once more.`);
      result = attempt(action);
    }
    if (!result.ok) {
      print(`Failed: ${action.description}. Fix: ${action.command} ${action.args.join(" ")}`);
      const detail = failureTail(result);
      if (detail) print(detail.split("\n").map((line) => `  | ${line}`).join("\n"));
      print(changed.length
        ? `Already changed: ${changed.join("; ")}. OpenClaw is part-way through this change.`
        : "Nothing was changed before it failed.");
      return { ok: false, actions, changed, failed: action.description, checks: [] };
    }
    changed.push(action.description);
  }
  print(`Changed: ${changed.length ? changed.join("; ") : "nothing"}.`);
  const checks = verifyOpenclaw({ run, command, vendors });
  for (const check of checks) print(`${check.ok ? "OK" : "FAIL"}: ${check.message}${check.ok ? "" : ` Fix: ${check.fix}`}`);
  return { ok: checks.every((check) => check.ok), actions, changed, checks };
}
