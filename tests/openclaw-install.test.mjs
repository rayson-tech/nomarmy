import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PINNED_OPENCLAW_VERSION, runOpenclawCommand, openclawInstallPlan, repairOpenclaw, verifyOpenclaw, configuredSubscriptionVendors } from "../lib/openclaw-install.mjs";

const action = { description: "Upgrade OpenClaw to 2026.9.6", command: "npm", args: ["install", "-g", "openclaw@2026.9.6"] };
// Trimmed stdout supplied by the coordinator from OpenClaw 2026.9.6.
const statusEvidence = {"update":{"root":"/Users/jasonpugh/.npm-global/lib/node_modules/openclaw","installKind":"package","packageManager":"npm","registry":{"latestVersion":"2026.9.7","tag":"latest"}},"channel":{"value":"stable","source":"default"},"availability":{"available":true,"hasRegistryUpdate":true,"latestVersion":"2026.9.7"},"migrationWarnings":["Plugin \"codex\" data/settings upgrade is unfinished: The installed plugin has not confirmed that its saved data and settings are ready for this version. If Doctor cannot finish the upgrade, report this warning to the plugin maintainer. Your existing data and settings have been kept. Run \"openclaw doctor --fix\" to retry the upgrade."]};
const pluginEvidence = {"workspaceDir":"/Users/jasonpugh/.openclaw/workspace","plugin":{"id":"codex","name":"Codex","packageVersion":"2026.9.6","version":"2026.9.6","builtWithOpenClawVersion":"2026.9.6","packageName":"@openclaw/codex","format":"openclaw","origin":"global","enabled":true,"explicitlyEnabled":true}};
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
function fixture({ installed = "2026.9.4", plugin = true, pluginVersion = "2026.9.6", pluginResult,
  status = { ok: true, stdout: JSON.stringify({ ...statusEvidence, migrationWarnings: [] }) }, installOk = true } = {}) {
  const calls = [], output = [];
  let current = installed;
  const run = (command, args) => {
    calls.push([command, [...args]]);
    if (command === "npm") { if (installOk) current = "2026.9.6"; return { ok: installOk, stdout: "" }; }
    if (args[0] === "--version") return { ok: Boolean(current), stdout: current ? `OpenClaw ${current}` : "" };
    if (args[0] === "plugins") return pluginResult ?? { ok: plugin, stdout: plugin ? JSON.stringify({ ...pluginEvidence, plugin: { ...pluginEvidence.plugin, id: args[2], builtWithOpenClawVersion: pluginVersion } }) : "" };
    if (args.join(" ") === "update status --json") return status;
    if (args.join(" ") === "doctor --help") return { ok: true, stdout: "--lint Read-only diagnostics" };
    if (args.join(" ") === "doctor --lint") return lintEvidence;
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, output, run, print: (line) => output.push(line) };
}

test("old-version repair installs exactly the one tested pin and verifies configured vendors", async () => {
  const f = fixture();
  const result = await repairOpenclaw({ ...f, yes: true, vendors: ["codex", "meta", "claude"] });
  assert.equal(PINNED_OPENCLAW_VERSION, "2026.9.6");
  assert.deepEqual(result, {
    ok: true, actions: [action], changed: [action.description], checks: [
      { id: "openclaw", ok: true, message: "OpenClaw 2026.9.6.", fix: "npm install -g openclaw@2026.9.6" },
      { id: "openclaw-plugin:codex", ok: true, message: "OpenClaw plugin codex 2026.9.6 is ready (built for 2026.9.6; OpenClaw is 2026.9.6).", fix: "openclaw plugins install clawhub:@openclaw/codex" },
      { id: "openclaw-plugin:meta", ok: true, message: "OpenClaw plugin meta 2026.9.6 is ready (built for 2026.9.6; OpenClaw is 2026.9.6).", fix: "openclaw plugins install clawhub:@openclaw/meta-provider" },
      { id: "openclaw-migrations", ok: true, message: "No pending OpenClaw migrations.", fix: "openclaw update repair" },
    ],
  });
  assert.deepEqual(f.calls, [
    ["openclaw", ["--version"]], ["npm", ["install", "-g", "openclaw@2026.9.6"]],
    ["openclaw", ["--version"]], ["openclaw", ["plugins", "inspect", "codex", "--json"]],
    ["openclaw", ["plugins", "inspect", "meta", "--json"]], ["openclaw", ["update", "status", "--json"]],
  ]);
  assert.deepEqual(f.output.slice(0, 8), [
    "Planned changes:",
    "  Upgrade OpenClaw to 2026.9.6: npm install -g openclaw@2026.9.6",
    "Postflight checks (read-only):",
    "  openclaw --version",
    "  openclaw plugins inspect codex --json",
    "  openclaw plugins inspect meta --json",
    "  openclaw update status --json",
    "  Migration repairs are not run automatically. If needed, run openclaw update repair --yes separately.",
  ]);
  assert.equal(f.output.includes("Changed: Upgrade OpenClaw to 2026.9.6."), true);
});

test("newer installed OpenClaw is reported without any install or downgrade", async () => {
  const f = fixture({ installed: "2026.10.1" });
  const result = await repairOpenclaw({ ...f, yes: true });
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.changed, []);
  assert.equal(result.ok, true);
  assert.equal(result.checks[0].message, "OpenClaw 2026.10.1 is newer than the tested release; left unchanged.");
  assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["--version"]], ["openclaw", ["update", "status", "--json"]]]);
});

test("missing codex after install fails with the exact plugin fix command", async () => {
  const f = fixture({ plugin: false });
  const result = await repairOpenclaw({ ...f, yes: true, vendors: ["codex"] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks[1], {
    id: "openclaw-plugin:codex", ok: false,
    message: "OpenClaw plugin codex is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.9.6.",
    fix: "openclaw plugins install clawhub:@openclaw/codex",
  });
  assert.equal(f.output.at(-2), "FAIL: OpenClaw plugin codex is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.9.6. Fix: openclaw plugins install clawhub:@openclaw/codex");
});

test("pending migrations even with a zero exit fail with the exact repair command", async () => {
  const f = fixture({ status: { ok: true, stdout: JSON.stringify(statusEvidence) } });
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
        "  Upgrade OpenClaw to 2026.9.6: npm install -g openclaw@2026.9.6",
        "Postflight checks (read-only):",
        "  openclaw --version",
        "  openclaw update status --json",
        "  Migration repairs are not run automatically. If needed, run openclaw update repair --yes separately.",
      ]);
      assert.deepEqual(f.calls, [["openclaw", ["--version"]]]);
      return answer;
    } });
    assert.equal(prompts, 1);
    assert.deepEqual(result, { ok: false, actions: [action], changed: [], checks: [] });
    assert.deepEqual(f.calls, [["openclaw", ["--version"]]]);
    assert.equal(f.output.at(-1), "No changes made.");
  }
});

test("noninteractive doctor fix without yes makes no changes and does not prompt", async () => {
  const f = fixture();
  const result = await repairOpenclaw({ ...f, ask: () => assert.fail("must not prompt") });
  assert.deepEqual(result, { ok: false, actions: [action], changed: [], checks: [] });
  assert.deepEqual(f.calls, [["openclaw", ["--version"]]]);
  assert.equal(f.output.at(-1), "No changes made. Non-interactive repair requires --yes.");
});

test("terminal yes applies only listed actions and reports them", async () => {
  const f = fixture();
  let prompts = 0;
  const result = await repairOpenclaw({ ...f, isTTY: true, ask: async () => { prompts++; return "yes"; } });
  assert.equal(prompts, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ["Upgrade OpenClaw to 2026.9.6"]);
  assert.deepEqual(f.calls.filter(([command]) => command === "npm"), [["npm", ["install", "-g", "openclaw@2026.9.6"]]]);
  assert.equal(f.output.includes("Changed: Upgrade OpenClaw to 2026.9.6."), true);
});

test("failed or malformed migration status fails verification with a manual command", () => {
  for (const status of [
    { ok: false, stdout: JSON.stringify(statusEvidence) },
    { ok: true, stdout: "not JSON" },
    { ok: true, stdout: '{"migrationWarnings":null}' },
    { ok: true, stdout: '{"migrationWarnings":[12]}' },
  ]) {
    const f = fixture({ installed: "2026.9.6", status });
    assert.deepEqual(verifyOpenclaw(f).at(-1), {
      id: "openclaw-migrations", ok: false,
      message: "OpenClaw migrations could not be verified. Run openclaw update status --json by hand.",
      fix: "openclaw update status --json",
    });
    assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["update", "status", "--json"]]]);
  }
});

test("older enabled meta plugin is ready and reports its build and installed versions", () => {
  const f = fixture({ installed: "2026.9.6", pluginResult: {
    ok: true, stdout: JSON.stringify({ ...pluginEvidence, plugin: {
      ...pluginEvidence.plugin, id: "meta", enabled: true,
      version: "2026.9.3", builtWithOpenClawVersion: "2026.9.3",
    } }),
  } });
  assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["meta"] })[1], {
    id: "openclaw-plugin:meta", ok: true,
    message: "OpenClaw plugin meta 2026.9.3 is ready (built for 2026.9.3; OpenClaw is 2026.9.6).",
    fix: "openclaw plugins install clawhub:@openclaw/meta-provider",
  });
});

test("a failed npm install is reported without a successful change or postflight", async () => {
  const f = fixture({ installOk: false });
  const result = await repairOpenclaw({ ...f, yes: true });
  assert.deepEqual(result, { ok: false, actions: [action], changed: [], checks: [] });
  assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["npm", action.args]]);
  assert.equal(f.output.at(-1), "Completed changes: none. The failed install may have partially modified OpenClaw.");
});

test("missing OpenClaw and a user prefix still use the exact shared pin", () => {
  assert.deepEqual(openclawInstallPlan(null, { prefix: "/example/.npm-global" }), [{
    description: "Install OpenClaw to 2026.9.6", command: "npm",
    args: ["install", "-g", "openclaw@2026.9.6", "--prefix", "/example/.npm-global"],
  }]);
});

test("all configured subscription vendors are selected once, not API agents", () => {
  assert.deepEqual(configuredSubscriptionVendors({
    a: { kind: "subscription", provider: "openai" }, b: { kind: "subscription", provider: "meta" },
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
    const f = fixture({ installed: "2026.9.6", status: {
      ok: true, stdout: JSON.stringify({ ...statusEvidence, migrationWarnings: warnings }), stderr: lintEvidence.stdout,
    } });
    assert.deepEqual(verifyOpenclaw(f).at(-1), {
      id: "openclaw-migrations", ok: true, message: "No pending OpenClaw migrations.", fix: "openclaw update repair",
    });
    assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["update", "status", "--json"]]]);
  }
});

test("plugin JSON accepts leading warnings and uses only stdout", () => {
  const f = fixture({ installed: "2026.9.6", pluginResult: {
    ok: true, stdout: warningEvidence + JSON.stringify(pluginEvidence), stderr: '{"plugin":{"enabled":false}}',
  } });
  assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["codex"] })[1], {
    id: "openclaw-plugin:codex", ok: true, message: "OpenClaw plugin codex 2026.9.6 is ready (built for 2026.9.6; OpenClaw is 2026.9.6).",
    fix: "openclaw plugins install clawhub:@openclaw/codex",
  });
  assert.deepEqual(f.calls, [["openclaw", ["--version"]], ["openclaw", ["plugins", "inspect", "codex", "--json"]], ["openclaw", ["update", "status", "--json"]]]);
});

test("plugin readiness accepts equal and older builds, but rejects newer, disabled, and unreadable builds", () => {
  const ready = (version) => `OpenClaw plugin codex ${version} is ready (built for ${version}; OpenClaw is 2026.9.6).`;
  const failed = "OpenClaw plugin codex is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.9.6.";
  for (const [overrides, expected] of [
    [{}, ready("2026.9.6")],
    [{version: "2026.9.5"}, ready("2026.9.6")],
    [{builtWithOpenClawVersion: undefined, version: "2026.9.5"}, ready("2026.9.5")],
    [{builtWithOpenClawVersion: "2026.9.7"}, failed],
    [{builtWithOpenClawVersion: null}, failed],
    [{enabled: false}, failed],
    [{enabled: "true"}, failed],
  ]) {
    const f = fixture({ installed: "2026.9.6", pluginResult: {
      ok: true, stdout: JSON.stringify({ ...pluginEvidence, plugin: { ...pluginEvidence.plugin, ...overrides } }),
    } });
    assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["codex"] })[1], {
      id: "openclaw-plugin:codex", ok: expected !== failed,
      message: expected,
      fix: "openclaw plugins install clawhub:@openclaw/codex",
    });
  }
});

test("enabled plugin without version fields fails verification", () => {
  const f = fixture({ installed: "2026.9.6", pluginResult: {
    ok: true, stdout: JSON.stringify({ plugin: { id: "codex", enabled: true } }),
  } });
  assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["codex"] })[1], {
    id: "openclaw-plugin:codex", ok: false,
    message: "OpenClaw plugin codex version could not be verified.",
    fix: "openclaw plugins install clawhub:@openclaw/codex",
  });
});

test("unreadable plugin JSON fails with the plugin fix command", () => {
  const f = fixture({ installed: "2026.9.6", pluginResult: { ok: true, stdout: "not JSON" } });
  assert.deepEqual(verifyOpenclaw({ ...f, vendors: ["meta"] })[1], {
    id: "openclaw-plugin:meta", ok: false,
    message: "OpenClaw plugin meta is missing, disabled, unreadable, or built for a newer OpenClaw than 2026.9.6.",
    fix: "openclaw plugins install clawhub:@openclaw/meta-provider",
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
    fix: "npm install -g openclaw@2026.9.6",
  }]);
});
