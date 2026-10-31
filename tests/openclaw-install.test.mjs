import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PINNED_OPENCLAW_VERSION, runOpenclawCommand, openclawInstallPlan, pluginUpdatePlan, repairOpenclaw, verifyOpenclaw, configuredSubscriptionVendors, codexBinaryCheck, failureTail, bundledPlugin, pluginInstallArgs } from "../lib/openclaw-install.mjs";
import { SUBSCRIPTION_VENDORS } from "../lib/subscription-setup.mjs";
import os from "node:os";
import path from "node:path";

// Never this machine's own OpenClaw: codexBinaryCheck reads the plugin from OpenClaw's home.
process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-openclaw-home-"));

const action = { description: "Upgrade OpenClaw to 2026.10.3", command: "npm", args: ["install", "-g", "openclaw@2026.10.3"] };
const migrate = { description: "Migrate OpenClaw's state to the new release", command: "openclaw", args: ["doctor", "--fix", "--non-interactive"], timeoutMs: 300000 };
// Trimmed stdout captured from OpenClaw 2026.9.6, its versions moved forward with the pin.
const statusEvidence = {"update":{"root":"/Users/jasonpugh/.npm-global/lib/node_modules/openclaw","installKind":"package","packageManager":"npm","registry":{"latestVersion":"2026.10.3","tag":"latest"}},"channel":{"value":"stable","source":"default"},"availability":{"available":true,"hasRegistryUpdate":true,"latestVersion":"2026.10.3"},"migrationWarnings":["Plugin \"codex\" data/settings upgrade is unfinished: The installed plugin has not confirmed that its saved data and settings are ready for this version. If Doctor cannot finish the upgrade, report this warning to the plugin maintainer. Your existing data and settings have been kept. Run \"openclaw doctor --fix\" to retry the upgrade."]};
const pluginEvidence = {"workspaceDir":"/Users/jasonpugh/.openclaw/workspace","plugin":{"id":"codex","name":"Codex","packageVersion":"2026.10.3","version":"2026.10.3","builtWithOpenClawVersion":"2026.10.3","packageName":"@openclaw/codex","format":"openclaw","origin":"global","enabled":true,"explicitlyEnabled":true}};
const warningEvidence = `│
◇  Doctor warnings ───────╮
│  - Plugin "codex" data/settings upgrade is unfinished: ...
├─────────────────────────╯
`;
// Ellipses in the supplied lint evidence are omitted, retaining its real fields.
const lintEvidence = { ok: false, stdout: JSON.stringify({schemaVersion:1,ok:false,checksRun:36,findings:[
  {checkId:"core/doctor/browser",severity:"warning"},
  {checkId:"core/doctor/node-hosting-preconditions",severity:"warning"},
  {checkId:"core/doctor/security",severity:"warning"},
  {checkId:"core/doctor/skill-workshop-tool-policy",severity:"warning"},
]}) };
function fixture({ installed = "2026.9.4", plugin = true, pluginVersion = "2026.10.3", pluginResult,
  status = { ok: true, stdout: JSON.stringify({ ...statusEvidence, migrationWarnings: [] }) }, installOk = true, doctorOk = true } = {}) {
  const calls = [], output = [];
  let current = installed;
  const run = (command, args) => {
    calls.push([command, [...args]]);
    if (command === "npm") { if (installOk) current = "2026.10.3"; return { ok: installOk, stdout: "" }; }
    if (args[0] === "--version") return { ok: Boolean(current), stdout: current ? `OpenClaw ${current}` : "" };
    if (args[0] === "plugins") return pluginResult ?? { ok: plugin, stdout: plugin ? JSON.stringify({ ...pluginEvidence, plugin: { ...pluginEvidence.plugin, id: args[2], builtWithOpenClawVersion: pluginVersion } }) : "" };
    if (args.join(" ") === "update status --json") return status;
    if (args.join(" ") === "doctor --fix --non-interactive") return { ok: doctorOk, stdout: "" };
    if (args.join(" ") === "doctor --help") return { ok: true, stdout: "--lint Read-only diagnostics" };
    if (args.join(" ") === "doctor --lint") return lintEvidence;
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, output, run, print: (line) => output.push(line) };
}

test("old-version repair installs exactly the one tested pin and verifies configured vendors", async () => {
  const f = fixture();
  // meta's plugin is nomArmy's own, versioned with nomArmy (its own test below).
  const result = await repairOpenclaw({ ...f, yes: true, vendors: ["codex", "claude"] });
  assert.equal(PINNED_OPENCLAW_VERSION, "2026.10.3");
  assert.deepEqual(result, {
    ok: true, actions: [action, migrate], changed: [action.description, migrate.description], checks: [
      { id: "openclaw", ok: true, message: "OpenClaw 2026.10.3.", fix: "npm install -g openclaw@2026.10.3" },
      { id: "openclaw-plugin:codex", ok: true, message: "OpenClaw plugin codex 2026.10.3 is ready (built for 2026.10.3; OpenClaw is 2026.10.3).", fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force` },
      { id: "openclaw-migrations", ok: true, message: "No pending OpenClaw migrations.", fix: "openclaw update repair" },
    ],
  });
  assert.deepEqual(f.calls, [
    ["openclaw", ["--version"]], ["openclaw", ["plugins", "inspect", "codex", "--json"]],
    ["npm", ["install", "-g", "openclaw@2026.10.3"]], ["openclaw", ["doctor", "--fix", "--non-interactive"]],
    ["openclaw", ["--version"]], ["openclaw", ["plugins", "inspect", "codex", "--json"]],
    ["openclaw", ["update", "status", "--json"]],
  ]);
  assert.deepEqual(f.output.slice(0, 7), [
    "Planned changes:",
    "  Upgrade OpenClaw to 2026.10.3: npm install -g openclaw@2026.10.3",
    "  Migrate OpenClaw's state to the new release: openclaw doctor --fix --non-interactive",
    "Postflight checks (read-only):",
    "  openclaw --version",
    "  openclaw plugins inspect codex --json",
    "  openclaw update status --json",
  ]);
  assert.equal(f.output.includes("Changed: Upgrade OpenClaw to 2026.10.3; Migrate OpenClaw's state to the new release."), true);
});

test("newer installed OpenClaw is reported without any install or downgrade", async () => {
  const f = fixture({ installed: "2026.11.1" });
  const result = await repairOpenclaw({ ...f, yes: true });
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.changed, []);
  assert.equal(result.ok, true);
  assert.equal(result.checks[0].message, "OpenClaw 2026.11.1 is newer than the tested release; left unchanged.");
  assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["--version"]], ["openclaw", ["update", "status", "--json"]]]);
});

test("missing codex after install fails with the exact plugin fix command", async () => {
  const f = fixture({ plugin: false });
  const result = await repairOpenclaw({ ...f, yes: true, vendors: ["codex"] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks[1], {
    id: "openclaw-plugin:codex", ok: false,
    message: "OpenClaw plugin codex is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.10.3.",
    fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`,
  });
  assert.equal(f.output.at(-2), `FAIL: OpenClaw plugin codex is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.10.3. Fix: openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`);
});

test("pending migrations even with a zero exit fail with the exact repair command", async () => {
  const f = fixture({ installed: "2026.10.3", status: { ok: true, stdout: JSON.stringify(statusEvidence) } });
  const result = await repairOpenclaw({ ...f, yes: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.at(-1), {
    id: "openclaw-migrations", ok: false,
    message: statusEvidence.migrationWarnings[0],
    fix: "openclaw update repair",
  });
  assert.equal(f.calls.some(([, args]) => args.includes("--fix")), false);
});

test("doctor fix prints the complete plan before one default-no terminal prompt", async () => {
  for (const answer of ["no", ""]) {
    const f = fixture();
    let prompts = 0;
    const result = await repairOpenclaw({ ...f, isTTY: true, ask: async (prompt) => {
      prompts++;
      assert.equal(prompt, "Apply these changes? [y/N] ");
      assert.deepEqual(f.output, [
        "Planned changes:",
        "  Upgrade OpenClaw to 2026.10.3: npm install -g openclaw@2026.10.3",
        "  Migrate OpenClaw's state to the new release: openclaw doctor --fix --non-interactive",
        "Postflight checks (read-only):",
        "  openclaw --version",
        "  openclaw update status --json",
      ]);
      assert.deepEqual(f.calls, [["openclaw", ["--version"]]]);
      return answer;
    } });
    assert.equal(prompts, 1);
    assert.deepEqual(result, { ok: false, declined: true, actions: [action, migrate], changed: [], checks: [] });
    assert.deepEqual(f.calls, [["openclaw", ["--version"]]]);
    assert.equal(f.output.at(-1), "No changes made.");
  }
});

test("noninteractive doctor fix without yes makes no changes and does not prompt", async () => {
  const f = fixture();
  const result = await repairOpenclaw({ ...f, ask: () => assert.fail("must not prompt") });
  assert.deepEqual(result, { ok: false, declined: true, actions: [action, migrate], changed: [], checks: [] });
  assert.deepEqual(f.calls, [["openclaw", ["--version"]]]);
  assert.equal(f.output.at(-1), "No changes made. Non-interactive repair requires --yes.");
});

test("terminal yes applies only listed actions and reports them", async () => {
  const f = fixture();
  let prompts = 0;
  const result = await repairOpenclaw({ ...f, isTTY: true, ask: async () => { prompts++; return "yes"; } });
  assert.equal(prompts, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["Upgrade OpenClaw to 2026.10.3", "Migrate OpenClaw's state to the new release"]);
  assert.deepEqual(f.calls.filter(([command]) => command === "npm"), [["npm", ["install", "-g", "openclaw@2026.10.3"]]]);
  assert.equal(f.output.includes("Changed: Upgrade OpenClaw to 2026.10.3; Migrate OpenClaw's state to the new release."), true);
});

test("a failed state migration after an upgrade stops before postflight, with Doctor's command as the fix", async () => {
  const f = fixture({ doctorOk: false });
  const result = await repairOpenclaw({ ...f, yes: true });
  assert.deepEqual(result, { ok: false, actions: [action, migrate], changed: [action.description], failed: migrate.description, checks: [] });
  assert.equal(f.output.at(-2), "Failed: Migrate OpenClaw's state to the new release. Fix: openclaw doctor --fix --non-interactive");
  assert.equal(f.output.at(-1), "Already changed: Upgrade OpenClaw to 2026.10.3. OpenClaw is part-way through this change.");
});

test("doctor --fix runs only after an upgrade: never on a fresh install, at the pin, or on a rollback", async () => {
  for (const [installed, exact] of [[null, false], ["2026.10.3", false], ["2026.11.1", true]]) {
    const f = fixture({ installed });
    const result = await repairOpenclaw({ ...f, yes: true, exact });
    assert.equal(f.calls.some(([, args]) => args[0] === "doctor" && args.includes("--fix")), false, String(installed));
    assert.equal(result.actions.some((x) => x.args[0] === "doctor"), false, String(installed));
  }
});

test("failed or malformed migration status fails verification with a manual command", () => {
  for (const status of [
    { ok: false, stdout: JSON.stringify(statusEvidence) },
    { ok: true, stdout: "not JSON" },
    { ok: true, stdout: '{"migrationWarnings":null}' },
    { ok: true, stdout: '{"migrationWarnings":[12]}' },
  ]) {
    const f = fixture({ installed: "2026.10.3", status });
    assert.deepEqual(verifyOpenclaw(f).at(-1), {
      id: "openclaw-migrations", ok: false,
      message: "OpenClaw migrations could not be verified. Run openclaw update status --json by hand.",
      fix: "openclaw update status --json",
    });
    assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["update", "status", "--json"]]]);
  }
});

test("a vendor plugin older than OpenClaw is ready at or past the pin, and needs an update below it", () => {
  const codex = (installed, version) => verifyOpenclaw({ ...fixture({ installed, pluginResult: {
    ok: true, stdout: JSON.stringify({ ...pluginEvidence, plugin: { ...pluginEvidence.plugin, id: "codex", enabled: true, version, builtWithOpenClawVersion: version } }),
  } }), vendors: ["codex"] })[1];
  assert.deepEqual(codex("2026.11.1", "2026.10.3"), {
    id: "openclaw-plugin:codex", ok: true,
    message: "OpenClaw plugin codex 2026.10.3 is ready (built for 2026.10.3; OpenClaw is 2026.11.1).",
    fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`,
  });
  // The real case: OpenClaw upgraded, its 2026.9.7 vendor plugins left behind.
  assert.deepEqual(codex("2026.10.3", "2026.9.7"), {
    id: "openclaw-plugin:codex", ok: false,
    message: "OpenClaw plugin codex 2026.9.7 is older than the tested release 2026.10.3.",
    fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`,
  });
});

test("a failed npm install is reported without a successful change or postflight", async () => {
  const f = fixture({ installOk: false });
  const result = await repairOpenclaw({ ...f, yes: true });
  assert.deepEqual(result, { ok: false, actions: [action, migrate], changed: [], failed: action.description, checks: [] });
  // Tried twice: a step that fails once right after OpenClaw changed can pass on a second try.
  assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["npm", action.args], ["npm", action.args]]);
  assert.equal(f.output.at(-1), "Nothing was changed before it failed.");
});

test("a failed step prints the last lines its command wrote, not just the command", async () => {
  const output = [];
  const run = (command, args) => command === "npm" ? { ok: false, stdout: "resolving...", stderr: "npm error code ETARGET\nnpm error notarget No matching version" }
    : { ok: true, stdout: "OpenClaw 2026.9.4" };
  await repairOpenclaw({ run, print: (line) => output.push(line), yes: true });
  assert.ok(output.some((line) => line.split("\n").includes("  | npm error notarget No matching version")), output.join("\n"));
  assert.equal(failureTail({ stdout: "", stderr: "" }), "");
});

test("a step that fails once and passes on the retry counts as done", async () => {
  const f = fixture();
  let npmCalls = 0;
  const run = (command, args) => command === "npm" && ++npmCalls === 1 ? { ok: false, stdout: "", stderr: "transient" } : f.run(command, args);
  const result = await repairOpenclaw({ ...f, run, yes: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, [action.description, migrate.description]);
  assert.ok(f.output.includes(`${action.description} failed; trying once more.`));
});

test("missing OpenClaw and a user prefix still use the exact shared pin", () => {
  assert.deepEqual(openclawInstallPlan(null, { prefix: "/example/.npm-global" }), [{
    description: "Install OpenClaw to 2026.10.3", command: "npm",
    args: ["install", "-g", "openclaw@2026.10.3", "--prefix", "/example/.npm-global"],
  }]);
});

test("all configured subscription vendors are selected once, not API agents", () => {
  assert.deepEqual(configuredSubscriptionVendors({
    a: { kind: "subscription", provider: "openai" }, b: { kind: "subscription", provider: "muse-cli" },
    c: { kind: "subscription", provider: "openai" }, d: { kind: "subscription", provider: "claude-cli" },
    e: { kind: "api", provider: "openai" },
  }, ["codex"]), ["codex", "meta", "claude"]);
});

test("all installation entry points use the shared policy and doctor wires its consent flags", () => {
  const shell = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
  const cli = fs.readFileSync(new URL("../bin/nomarmy.mjs", import.meta.url), "utf8");
  assert.equal(shell.includes('node "$ROOT/scripts/install-openclaw.mjs"'), true);
  assert.equal(shell.includes('  node "$ROOT/scripts/install-openclaw.mjs"\n'), true);
  assert.equal(shell.includes('  node "$ROOT/scripts/install-openclaw.mjs" --prefix "$HOME/.npm-global"\n'), true);
  assert.doesNotMatch(shell, /npm\s+(?:install|update)\s+[^\n]*\bopenclaw(?:@|\s|$)/m);
  assert.equal(shell.includes("NOMARMY_OPENCLAW_VERSION"), false);
  assert.equal(cli.includes('["update", "-g", "openclaw"]'), false);
  assert.equal(cli.includes('yes: flag("yes"), isTTY: Boolean(input.isTTY)'), true);
  assert.equal(cli.includes("additionalChecks: checks"), true);
});


test("empty or absent migrationWarnings ignores unrelated lint-style advisories", () => {
  for (const warnings of [[], undefined]) {
    const f = fixture({ installed: "2026.10.3", status: {
      ok: true, stdout: JSON.stringify({ ...statusEvidence, migrationWarnings: warnings }), stderr: lintEvidence.stdout,
    } });
    assert.deepEqual(verifyOpenclaw(f).at(-1), {
      id: "openclaw-migrations", ok: true, message: "No pending OpenClaw migrations.", fix: "openclaw update repair",
    });
    assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["update", "status", "--json"]]]);
  }
});

test("plugin JSON accepts leading warnings and uses only stdout", () => {
  const f = fixture({ installed: "2026.10.3", pluginResult: {
    ok: true, stdout: warningEvidence + JSON.stringify(pluginEvidence), stderr: '{"plugin":{"enabled":false}}',
  } });
  assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["codex"] })[1], {
    id: "openclaw-plugin:codex", ok: true, message: "OpenClaw plugin codex 2026.10.3 is ready (built for 2026.10.3; OpenClaw is 2026.10.3).",
    fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`,
  });
  assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["plugins", "inspect", "codex", "--json"]], ["openclaw", ["update", "status", "--json"]]]);
});

test("plugin readiness accepts builds at the pin up to OpenClaw's, but rejects older-than-pin, newer, disabled, and unreadable builds", () => {
  const ready = (version) => `OpenClaw plugin codex ${version} is ready (built for ${version}; OpenClaw is 2026.10.3).`;
  const failed = "OpenClaw plugin codex is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.10.3.";
  for (const [overrides, expected] of [
    [{}, ready("2026.10.3")],
    [{version: "2026.9.5"}, ready("2026.10.3")],
    [{builtWithOpenClawVersion: undefined, version: "2026.10.3"}, ready("2026.10.3")],
    [{builtWithOpenClawVersion: undefined, version: "2026.9.5"}, "OpenClaw plugin codex 2026.9.5 is older than the tested release 2026.10.3."],
    [{builtWithOpenClawVersion: "2026.10.4"}, failed],
    [{builtWithOpenClawVersion: null}, failed],
    [{enabled: false}, failed],
    [{enabled: "true"}, failed],
  ]) {
    const f = fixture({ installed: "2026.10.3", pluginResult: {
      ok: true, stdout: JSON.stringify({ ...pluginEvidence, plugin: { ...pluginEvidence.plugin, ...overrides } }),
    } });
    assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["codex"] })[1], {
      id: "openclaw-plugin:codex", ok: expected.includes(" is ready "),
      message: expected,
      fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`,
    });
  }
});

test("enabled plugin without version fields fails verification", () => {
  const f = fixture({ installed: "2026.10.3", pluginResult: {
    ok: true, stdout: JSON.stringify({ plugin: { id: "codex", enabled: true } }),
  } });
  assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["codex"] })[1], {
    id: "openclaw-plugin:codex", ok: false,
    message: "OpenClaw plugin codex version could not be verified.",
    fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`,
  });
});

test("unreadable plugin JSON fails with the plugin fix command", () => {
  const f = fixture({ installed: "2026.10.3", pluginResult: { ok: true, stdout: "not JSON" } });
  assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["codex"] })[1], {
    id: "openclaw-plugin:codex", ok: false,
    message: "OpenClaw plugin codex is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.10.3.",
    fix: `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`,
  });
});

test("migration warnings are all reported verbatim without broad repairs", () => {
  const warnings = [...statusEvidence.migrationWarnings, "Second pending migration."];
  const f = fixture({ status: { ok: true, stdout: JSON.stringify({ ...statusEvidence, migrationWarnings: warnings }) } });
  assert.deepEqual(verifyOpenclaw(f).at(-1), {
    id: "openclaw-migrations", ok: false, message: warnings.join("\n"), fix: "openclaw update repair",
  });
  assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["update", "status", "--json"]]]);
});

test("a timed-out OpenClaw command fails version verification with a timeout message", () => {
  const command = process.execPath;
  const result = runOpenclawCommand(command, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 30 });
  assert.deepEqual(result, { ok: false, stdout: "", stderr: "Command timed out after 30 ms.", timedOut: true });
  const checks = verifyOpenclaw({ command, run: () => result });
  assert.deepEqual(checks, [{
    id: "openclaw", ok: false, message: "OpenClaw version check timed out.",
    fix: "npm install -g openclaw@2026.10.3",
  }]);
});

test("OpenClaw at the pin with vendor plugins behind it: repair updates exactly those plugins, after asking", async () => {
  // Shaped like this machine on 2026-10-11: OpenClaw at the pin, its codex plugin behind it.
  const versions = { codex: "2026.9.7" };
  const calls = [], output = [];
  const run = (command, args) => {
    calls.push([command, [...args]]);
    if (args[0] === "--version") return { ok: true, stdout: "OpenClaw 2026.10.3 (e178c39)" };
    if (args[0] === "plugins" && args[1] === "install") { versions.codex = args[2].split("@").at(-1); return { ok: true, stdout: "" }; }
    if (args[0] === "plugins" && args[1] === "inspect") return { ok: true, stdout: JSON.stringify({ ...pluginEvidence, plugin: { ...pluginEvidence.plugin, id: args[2], version: versions[args[2]], builtWithOpenClawVersion: versions[args[2]] } }) };
    if (args.join(" ") === "update status --json") return { ok: true, stdout: JSON.stringify({ ...statusEvidence, migrationWarnings: [] }) };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const plugin = { description: `Update OpenClaw plugin codex 2026.9.7 to ${PINNED_OPENCLAW_VERSION}`, command: "openclaw", args: ["plugins", "install", `clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION}`, "--force"], pluginId: "codex" };

  const declined = await repairOpenclaw({ run, print: (l) => output.push(l), vendors: ["codex", "claude"], isTTY: true, ask: async () => "n" });
  assert.deepEqual(declined, { ok: false, declined: true, actions: [plugin], changed: [], checks: [] });
  assert.equal(output[1], `  Update OpenClaw plugin codex 2026.9.7 to ${PINNED_OPENCLAW_VERSION}: openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`);
  assert.equal(calls.some(([, args]) => args[1] === "update"), false);

  const before = verifyOpenclaw({ run, vendors: ["codex"] })[1];
  assert.deepEqual([before.ok, before.fix], [false, `openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`]);

  calls.length = 0;
  const applied = await repairOpenclaw({ run, print: () => {}, vendors: ["codex"], yes: true });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.changed, [plugin.description]);
  assert.deepEqual(calls.filter(([, args]) => args[1] === "install"), [["openclaw", ["plugins", "install", `clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION}`, "--force"]]]);
  assert.equal(calls.some(([command]) => command === "npm"), false, "OpenClaw itself is already at the pin");
});

test("a configured vendor whose plugin was never installed gets it at the pin, without --force", () => {
  const run = (command, args) => args[1] === "inspect"
    ? { ok: false, stdout: JSON.stringify({ ok: false, error: { type: "cli_error", message: `Plugin not found: ${args[2]}. Run \`openclaw plugins list\`` } }), stderr: "" }
    : { ok: false, stdout: "", stderr: "Command timed out after 60000 ms.", timedOut: true };
  assert.deepEqual(pluginUpdatePlan({ run, vendors: ["codex"] }), [{
    description: `Install OpenClaw plugin codex ${PINNED_OPENCLAW_VERSION}`, command: "openclaw",
    args: ["plugins", "install", `clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION}`], pluginId: "codex",
  }]);
  const timedOut = () => ({ ok: false, stdout: "", stderr: "Command timed out after 60000 ms.", timedOut: true });
  assert.deepEqual(pluginUpdatePlan({ run: timedOut, vendors: ["codex"] }), [], "an inspect that failed for another reason installs nothing");
});

test("install.sh --server is the hosted profile only, and an npm-installed copy never runs npm install in place", { skip: process.platform === "win32" && "bash script" }, () => {
  const refused = spawnSync("bash", [fileURLToPath(new URL("../install.sh", import.meta.url)), "--server", "--profile", "macbook-pro"], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--server installs the hosted profile, not 'macbook-pro'/);
  const shell = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
  const guard = shell.indexOf('if [[ "$ROOT" == */node_modules/* ]]; then\n  : # Installed from npm');
  assert.ok(guard > 0 && guard < shell.indexOf("npm install --omit=dev"), "npm install sits behind the node_modules guard");
});

test("a plugin install saved but not hot-reloaded by the running Gateway is reloaded, not reported as failed", async () => {
  // Seen live installing codex 2026.10.2: "config reload superseded by a newer runtime config source".
  let codex = "2026.9.7";
  const calls = [];
  const run = (command, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { ok: true, stdout: `OpenClaw ${PINNED_OPENCLAW_VERSION} (b8952d4)` };
    if (args[1] === "install") { codex = PINNED_OPENCLAW_VERSION; return { ok: false, stdout: "Plugin operation failed during drain: config reload superseded by a newer runtime config source", stderr: "" }; }
    if (args[1] === "reload") return { ok: true, stdout: "Reloaded plugin \"codex\"" };
    if (args[1] === "inspect") return { ok: true, stdout: JSON.stringify({ ...pluginEvidence, plugin: { ...pluginEvidence.plugin, version: codex, builtWithOpenClawVersion: codex } }) };
    if (args.join(" ") === "update status --json") return { ok: true, stdout: JSON.stringify({ ...statusEvidence, migrationWarnings: [] }) };
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  const result = await repairOpenclaw({ run, vendors: ["codex"], yes: true, print: () => {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, [`Update OpenClaw plugin codex 2026.9.7 to ${PINNED_OPENCLAW_VERSION}`]);
  assert.ok(calls.includes("plugins reload codex"));
});

test("a rollback installs the exact earlier release of OpenClaw and its plugins; a target past the pin upgrades to it", () => {
  assert.deepEqual(openclawInstallPlan("OpenClaw 2099.1.1", { target: "2026.10.3", exact: true }), [{ description: "Roll back OpenClaw to 2026.10.3", command: "npm", args: ["install", "-g", "openclaw@2026.10.3"] }]);
  assert.deepEqual(openclawInstallPlan("OpenClaw 2026.10.3", { target: "2026.10.3", exact: true }), []);
  assert.deepEqual(openclawInstallPlan("OpenClaw 2099.1.1", { target: "2026.10.3" }), [], "never a downgrade without exact");
  assert.equal(openclawInstallPlan("OpenClaw 2026.10.3", { target: "2099.1.1" })[0].description, "Upgrade OpenClaw to 2099.1.1");
  const inspect = (version) => () => ({ ok: true, stdout: JSON.stringify({ plugin: { id: "codex", enabled: true, version, builtWithOpenClawVersion: version } }), stderr: "" });
  assert.deepEqual(pluginUpdatePlan({ run: inspect("2099.1.1"), vendors: ["codex"], target: "2026.10.3", exact: true }).map((a) => [a.description, a.args.join(" ")]),
    [["Roll back OpenClaw plugin codex 2099.1.1 to 2026.10.3", "plugins install clawhub:@openclaw/codex@2026.10.3 --force"]]);
  assert.deepEqual(pluginUpdatePlan({ run: inspect("2026.10.3"), vendors: ["codex"], target: "2099.1.1" }).map((a) => a.args.join(" ")),
    ["plugins install clawhub:@openclaw/codex@2099.1.1 --force"]);
  assert.deepEqual(pluginUpdatePlan({ run: inspect("2099.1.1"), vendors: ["codex"], target: "2026.10.3" }), []);
});

test("nomArmy's own muse-cli plugin: installed from this package and kept at its version, whatever OpenClaw's release", () => {
  const shipped = bundledPlugin(SUBSCRIPTION_VENDORS.meta.plugin);
  assert.ok(shipped.version, "the plugin's package.json carries a version");
  assert.ok(fs.existsSync(path.join(shipped.dir, "openclaw.plugin.json")));
  const install = ["plugins", "install", "--force", "--accept-capabilities", shipped.dir];
  assert.deepEqual(pluginInstallArgs(SUBSCRIPTION_VENDORS.meta.plugin), install);
  const inspect = (plugin) => () => plugin ? { ok: true, stdout: JSON.stringify({ plugin }), stderr: "" } : { ok: false, stdout: "", stderr: "Plugin not found: muse-cli" };
  const plan = (plugin, opts = {}) => pluginUpdatePlan({ run: inspect(plugin), vendors: ["meta"], ...opts }).map((a) => [a.description, a.args]);
  assert.deepEqual(plan(null), [["Install nomArmy's OpenClaw plugin muse-cli", install]]);
  assert.deepEqual(plan({ id: "muse-cli", enabled: true, version: "0.0.1" }), [[`Update nomArmy's OpenClaw plugin muse-cli 0.0.1 to ${shipped.version}`, install]]);
  assert.deepEqual(plan({ id: "muse-cli", enabled: false, version: shipped.version }), [["Enable nomArmy's OpenClaw plugin muse-cli", ["plugins", "enable", "muse-cli"]]]);
  // OpenClaw's own release doesn't move it, in either direction.
  assert.deepEqual(plan({ id: "muse-cli", enabled: true, version: shipped.version }, { target: "2099.1.1" }), []);
  assert.deepEqual(plan({ id: "muse-cli", enabled: true, version: shipped.version }, { target: "2026.10.3", exact: true }), []);
});

test("codexBinaryCheck: flags the Codex plugin missing its platform binary, with a copy-in fix; silent without a bundled Codex", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-codexbin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(codexBinaryCheck({ home, platform: "darwin", arch: "arm64" }), null);
  const modules = path.join(home, "extensions", "codex", "node_modules", "@openai");
  fs.mkdirSync(path.join(modules, "codex"), { recursive: true });
  fs.writeFileSync(path.join(modules, "codex", "package.json"), JSON.stringify({ version: "0.160.0" }));
  const missing = codexBinaryCheck({ home, platform: "darwin", arch: "arm64" });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /missing @openai\/codex-darwin-arm64/);
  assert.equal(missing.fix, `d=$(mktemp -d) && npm install --prefix "$d" --no-save @openai/codex-darwin-arm64@npm:@openai/codex@0.160.0-darwin-arm64 && cp -R "$d/node_modules/@openai/codex-darwin-arm64" "${modules}/" && rm -rf "$d"`);
  fs.mkdirSync(path.join(modules, "codex-darwin-arm64"));
  assert.equal(codexBinaryCheck({ home, platform: "darwin", arch: "arm64" }).ok, true);
  assert.equal(codexBinaryCheck({ home, platform: "linux", arch: "x64" }).ok, false);
});
