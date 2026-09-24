// CLI integration tests for bin/nomarmy.mjs non-interactive (--json) paths.
// Spawns the real CLI as a subprocess against temporary scratch directories.

import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(here, "..", "bin", "nomarmy.mjs");

function runCLI(args, options = {}) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-cli-test-"));
  try {
    const cwd = options.cwd ?? tmpDir;
    const result = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    return { exitCode: 0, stdout: result, stderr: "" };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeConfig(dir, config) {
  const configPath = path.join(dir, ".nomarmy.yml");
  fs.writeFileSync(configPath, config, "utf8");
}

test("validate --json on directory with no .nomarmy.yml returns found:false and exits 0", () => {
  const { exitCode, stdout } = runCLI(["validate", "--json"]);
  const output = JSON.parse(stdout);
  assert.equal(exitCode, 0);
  assert.equal(output.found, false);
});

test("validate --json on directory with valid .nomarmy.yml returns valid:true", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-validate-test-"));
  try {
    const validConfig = `verification:
  quick:
    commands:
      - echo ok
`;
    writeConfig(tmpDir, validConfig);

    const result = execFileSync(process.execPath, [CLI_PATH, "validate", "--json", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const output = JSON.parse(result);
    assert.equal(output.found, true);
    assert.equal(output.valid, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("init --json against existing .nomarmy.yml exits non-zero with error field", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-init-exists-test-"));
  try {
    writeConfig(tmpDir, "verification:\n  quick:\n    commands:\n      - echo ok\n");

    try {
      execFileSync(process.execPath, [CLI_PATH, "init", "--json", "--repo", tmpDir], {
        encoding: "utf8",
      });
      assert.fail("Expected execFileSync to throw on non-zero exit");
    } catch (error) {
      assert.equal(error.status, 1);
      const output = JSON.parse(error.stdout);
      assert.ok(output.error);
      assert.ok(output.error.includes("already exists"));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("init --json --write against fresh directory writes .nomarmy.yml and exits 0", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-init-write-test-"));
  try {
    const result = execFileSync(process.execPath, [CLI_PATH, "init", "--json", "--write", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const output = JSON.parse(result);
    assert.equal(output.written, path.join(tmpDir, ".nomarmy.yml"));
    assert.ok(fs.existsSync(output.written));

    const validateResult = execFileSync(process.execPath, [CLI_PATH, "validate", "--json", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const validateOutput = JSON.parse(validateResult);
    assert.equal(validateOutput.found, true);
    assert.equal(validateOutput.valid, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// uninstall --clear-models/--clear-agents: real removal is NOT exercised
// here. uninstall.sh unconditionally runs `claude mcp remove
// nomarmy-local-worker` -- this session's own live registration -- so any
// test that got past the refusal gate below would disconnect the real
// session running this suite. Only the safe-to-call-automatically part (the
// refusal that runs BEFORE uninstall.sh) is covered.
test("uninstall --clear-models --json without --force refuses before touching anything", () => {
  const { exitCode, stdout } = runCLI(["uninstall", "--clear-models", "--json"]);
  assert.notEqual(exitCode, 0);
  const output = JSON.parse(stdout);
  assert.match(output.error, /needs --force/);
});

test("uninstall --clear-agents --all --json without --force refuses before touching anything", () => {
  const { exitCode, stdout } = runCLI(["uninstall", "--clear-agents", "--json"]);
  assert.notEqual(exitCode, 0);
  assert.match(JSON.parse(stdout).error, /needs --force/);

  const allResult = runCLI(["uninstall", "--all", "--json"]);
  assert.notEqual(allResult.exitCode, 0);
  assert.match(JSON.parse(allResult.stdout).error, /needs --force/);
});

test("sizing --noms N --json sizes for the exact requested worker count", () => {
  const { exitCode, stdout } = runCLI(["sizing", "--noms", "4", "--json"]);
  assert.equal(exitCode, 0);
  const { recommendation } = JSON.parse(stdout);
  assert.equal(recommendation.requestedNoms, 4);
  assert.equal(recommendation.llamaParallel, 4);
  assert.equal(recommendation.maxWorkers, 4);
  assert.equal(recommendation.env.NOMARMY_LLAMA_PARALLEL, 4);
});

test("sizing --noms with a non-numeric value is refused with a clear error, not a crash", () => {
  const { exitCode, stdout } = runCLI(["sizing", "--noms", "banana", "--json"]);
  assert.notEqual(exitCode, 0);
  assert.match(JSON.parse(stdout).error, /--noms must be a positive number/);
});

test("sizing --noms an unreasonable count reports fits:false, not a crash or a silently smaller count", () => {
  const { exitCode, stdout } = runCLI(["sizing", "--noms", "9999", "--json"]);
  assert.equal(exitCode, 0);
  const { recommendation } = JSON.parse(stdout);
  assert.equal(recommendation.requestedNoms, 9999);
  assert.equal(recommendation.fits, false);
});

// `nomarmy agents` reads and writes ~/.config/nomarmy/agents.yml, so every
// test below runs a scratch copy of bin/+lib/ (node_modules symlinked) with
// NOMARMY_CONFIG_DIR pointed inside it: a test run never touches this
// developer's real agents.

function scratchNomarmyRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "nomarmy-providers-cli-"));
  const repoRoot = path.join(here, "..");
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  fs.cpSync(path.join(repoRoot, "bin"), path.join(dir, "bin"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(dir, "package.json"));
  return dir;
}

function runAgentsCLI(root, args, extraEnv = {}) {
  try {
    const result = execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "agents", ...args], {
      cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config"), ...extraEnv },
    });
    return { exitCode: 0, stdout: result, stderr: "" };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// `nomarmy agents add --register` shells out to a real `openclaw`
// binary. To verify EXACTLY what it's invoked with (argv and stdin) without
// touching a real OpenClaw install or a real credential, this points
// NOMARMY_OPENCLAW_CMD (registerProviderWithOpenClaw's own override, for
// exactly this purpose) at a fake script that logs every call (argv,
// joined; the full stdin it received) as one JSON line per invocation, to a
// fixed file. This is what actually caught (and now guards) a real bug: an
// earlier version of registerProviderWithOpenClaw destructured
// `authEnv`/`baseUrl` while the real entry object only ever has
// `auth_env`/`base_url`, so the piped "credential" was the literal string
// "null" on every call, silently.
//
// The script is written as valid ESM, not CommonJS (no `require`) --
// scratchNomarmyRoot's copied package.json declares "type": "module", and
// an extensionless script under that same tree is resolved as ESM by
// Node's own nearest-package.json walk-up regardless of its shebang line;
// `require` is undefined there and crashes the script before it can write
// anything, which is exactly what silently broke the first version of this
// helper (real invocations, wrong content, zero log entries, no visible
// error since the child's own stderr is intentionally ignored).
function withFakeOpenclaw(root) {
  const logPath = path.join(root, "fake-openclaw.log");
  const scriptPath = path.join(root, ".fake-openclaw-bin");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
import fs from "node:fs";
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_OPENCLAW_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }) + "\\n");
process.exit(0);
`);
  fs.chmodSync(scriptPath, 0o755);
  return {
    env: { NOMARMY_OPENCLAW_CMD: scriptPath, FAKE_OPENCLAW_LOG: logPath },
    calls: () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
  };
}

test("agents list --json with no agents.yml still has the built-in local agent", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runAgentsCLI(root, ["list", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.found, false);
    assert.deepEqual(output.agents, { local: { kind: "local", slot: "coder" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents add --json: one of each kind lands in one agents.yml, with each kind's defaults", () => {
  const root = scratchNomarmyRoot();
  try {
    assert.equal(runAgentsCLI(root, ["add", "--json", "--name", "local-gpt", "--kind", "local", "--slot", "gpt"]).exitCode, 0);
    assert.equal(runAgentsCLI(root, ["add", "--json", "--name", "grok", "--kind", "api", "--provider", "xai", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY"]).exitCode, 0);
    const sub = runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--model", "gpt-6-astra", "--owner", "you@example.com"]);
    assert.equal(sub.exitCode, 0, sub.stdout);
    const { agents } = JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout);
    assert.deepEqual(Object.keys(agents), ["local", "local-gpt", "grok", "codex"]);
    assert.equal(agents.grok.max_concurrent, 2);
    assert.equal(agents.codex.max_concurrent, 1, "a personal subscription defaults to one job at a time");
    assert.equal((fs.statSync(path.join(root, "config", "agents.yml")).mode & 0o077), 0, "agents.yml is written private to this account");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents add --json refuses a missing field, a reserved name, and an api/subscription clash on one provider id -- and leaves the file alone", () => {
  const root = scratchNomarmyRoot();
  try {
    const missing = runAgentsCLI(root, ["add", "--json", "--name", "grok", "--kind", "api", "--provider", "xai", "--model", "grok-4.7"]);
    assert.notEqual(missing.exitCode, 0);
    assert.match(JSON.parse(missing.stdout).errors.join("\n"), /auth_env: is required/);
    assert.notEqual(runAgentsCLI(root, ["add", "--json", "--name", "__proto__", "--kind", "local"]).exitCode, 0);
    runAgentsCLI(root, ["add", "--json", "--name", "grok", "--kind", "api", "--provider", "xai", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY"]);
    const clash = runAgentsCLI(root, ["add", "--json", "--name", "grok-sub", "--kind", "subscription", "--provider", "xai", "--model", "grok-4.7", "--owner", "o"]);
    assert.notEqual(clash.exitCode, 0);
    assert.match(JSON.parse(clash.stdout).errors.join("\n"), /OpenClaw provider "xai" is used by both api agent grok and subscription agent grok-sub/);
    assert.deepEqual(Object.keys(JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout).agents), ["local", "grok"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents add --json --register (native api provider, e.g. xai) pipes the REAL key via stdin, never argv", () => {
  const root = scratchNomarmyRoot();
  const fake = withFakeOpenclaw(root);
  try {
    const { exitCode, stdout } = runAgentsCLI(root, [
      "add", "--json", "--register", "--name", "grok", "--kind", "api", "--provider", "xai",
      "--model", "grok-4.7", "--auth-env", "NOMARMY_TEST_KEY_XAI",
    ], { ...fake.env, NOMARMY_TEST_KEY_XAI: "sk-test-real-secret-value" });
    assert.equal(exitCode, 0, stdout);
    const calls = fake.calls();
    assert.equal(calls.length, 1, "a native provider needs exactly one openclaw call (paste-api-key)");
    assert.deepEqual(calls[0].argv.slice(0, 5), ["models", "auth", "paste-api-key", "--provider", "xai"]);
    assert.equal(calls[0].stdin.trim(), "sk-test-real-secret-value", "the REAL key must be on stdin, not \"null\" or \"undefined\"");
    assert.ok(!calls[0].argv.join(" ").includes("sk-test-real-secret-value"), "the key must never appear in argv");
    assert.doesNotMatch(fs.readFileSync(path.join(root, "config", "agents.yml"), "utf8"), /sk-test/, "the key never reaches agents.yml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents add --json --register (custom endpoint) onboards with the REAL model/base_url, then pipes the key via stdin", () => {
  const root = scratchNomarmyRoot();
  const fake = withFakeOpenclaw(root);
  try {
    const { exitCode, stdout } = runAgentsCLI(root, [
      "add", "--json", "--register", "--name", "azure-mini", "--kind", "api", "--provider", "azure-openai",
      "--model", "gpt-4o-mini", "--auth-env", "NOMARMY_TEST_KEY_AZURE", "--base-url", "https://my-resource.openai.azure.com",
    ], { NOMARMY_TEST_KEY_AZURE: "sk-test-azure-secret", ...fake.env });
    assert.equal(exitCode, 0, stdout);
    const [onboardCall, pasteCall] = fake.calls();
    assert.ok(onboardCall.argv.includes("https://my-resource.openai.azure.com") && onboardCall.argv.includes("gpt-4o-mini"));
    assert.deepEqual(pasteCall.argv.slice(0, 3), ["models", "auth", "paste-api-key"]);
    assert.equal(pasteCall.stdin.trim(), "sk-test-azure-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents add --json: a generic openclaw api agent keeps its provider id and plugin", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runAgentsCLI(root, ["add", "--json", "--name", "deepseek", "--kind", "api", "--provider", "openclaw", "--openclaw-provider", "deepseek",
      "--plugin", "clawhub:@openclaw/deepseek-provider", "--model", "deepseek-chat", "--auth-env", "NOMARMY_DEEPSEEK_API_KEY"]);
    assert.equal(exitCode, 0, stdout);
    const { agent } = JSON.parse(stdout);
    assert.equal(agent.openclaw_provider, "deepseek");
    assert.equal(agent.plugin, "clawhub:@openclaw/deepseek-provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents update --json changes model/thinking, never kind, provider or owner, and swapping a native model calls no OpenClaw", () => {
  const root = scratchNomarmyRoot();
  const fake = withFakeOpenclaw(root);
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--model", "gpt-6-astra", "--owner", "you@example.com"]);
    runAgentsCLI(root, ["add", "--json", "--name", "grok", "--kind", "api", "--provider", "xai", "--model", "grok-4.6", "--auth-env", "NOMARMY_XAI_API_KEY"]);
    const updated = runAgentsCLI(root, ["update", "codex", "--json", "--model", "gpt-6-sol", "--thinking", "high"], fake.env);
    assert.equal(updated.exitCode, 0, updated.stdout);
    const { agent, changed } = JSON.parse(updated.stdout);
    assert.deepEqual({ model: agent.model, thinking: agent.thinking, owner: agent.owner, provider: agent.provider }, { model: "gpt-6-sol", thinking: "high", owner: "you@example.com", provider: "openai" });
    assert.deepEqual(changed.sort(), ["model", "thinking"]);
    assert.notEqual(runAgentsCLI(root, ["update", "codex", "--json", "--owner", "someone@example.com"]).exitCode, 0, "a different owner is a different agent");
    assert.equal(runAgentsCLI(root, ["update", "grok", "--json", "--model", "grok-4.7"], fake.env).exitCode, 0);
    assert.equal(fake.calls().length, 0, "a model swap never re-registers: the model is composed fresh at dispatch time");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents update/remove --json refuse an unknown agent and an empty update; the built-in local can't be removed", () => {
  const root = scratchNomarmyRoot();
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "grok", "--kind", "api", "--provider", "xai", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY"]);
    assert.notEqual(runAgentsCLI(root, ["update", "nope", "--json", "--model", "x"]).exitCode, 0);
    assert.notEqual(runAgentsCLI(root, ["update", "grok", "--json"]).exitCode, 0);
    assert.notEqual(runAgentsCLI(root, ["remove", "local", "--json"]).exitCode, 0);
    const removed = runAgentsCLI(root, ["remove", "grok", "--json"]);
    assert.equal(removed.exitCode, 0, removed.stdout);
    assert.deepEqual(Object.keys(JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout).agents), ["local"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan --json against empty temp directory returns evidence with zero counts", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-scan-empty-test-"));
  try {
    const result = execFileSync(process.execPath, [CLI_PATH, "scan", "--json", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const output = JSON.parse(result);
    assert.ok(output.counts);
    for (const [category, count] of Object.entries(output.counts)) {
      assert.equal(count, 0, `category ${category} should be 0`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// nomarmy army <init|assign|show>
// --------------------------------------------------------------------------
function runArmyCLI(root, repo, args) {
  try {
    const result = execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "army", ...args, "--repo", repo], {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config") },
    });
    return { exitCode: 0, stdout: result };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("army init/assign/general/show --json: global roster, a project override, a gitignored local override, and the General", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    runAgentsCLI(root, ["add", "--json", "--name", "grok", "--kind", "api", "--provider", "xai", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY"]);
    runAgentsCLI(root, ["add", "--json", "--name", "opus", "--kind", "subscription", "--provider", "claude-cli", "--model", "claude-opus-5", "--owner", "you@example.com"]);
    runAgentsCLI(root, ["add", "--json", "--name", "sonnet", "--kind", "subscription", "--provider", "claude-cli", "--model", "claude-sonnet-5", "--owner", "you@example.com"]);
    assert.equal(runArmyCLI(root, repo, ["init", "--json"]).exitCode, 0);
    assert.notEqual(runArmyCLI(root, repo, ["init", "--json"]).exitCode, 0, "never replaces an existing army without --force");
    assert.equal(runArmyCLI(root, repo, ["assign", "ui-ux", "grok", "--project", "--json"]).exitCode, 0);
    assert.equal(runArmyCLI(root, repo, ["assign", "ui-ux", "sonnet", "--local", "--json"]).exitCode, 0);
    assert.equal(runArmyCLI(root, repo, ["general", "opus", "--json"]).exitCode, 0);
    assert.notEqual(runArmyCLI(root, repo, ["general", "opus", "--project", "--json"]).exitCode, 0, "the General is personal, never in a committed file");
    const summary = JSON.parse(runArmyCLI(root, repo, ["show", "--json"]).stdout);
    assert.equal(summary.general.agent, "opus");
    assert.ok(summary.general.responsibilities.length > 0, "the charter is always there");
    assert.equal(summary.roles["ui-ux"].agent, "sonnet");
    assert.equal(summary.roles["ui-ux"].setBy.agent, "local");
    assert.equal(summary.roles["ui-ux"].setBy.description, "global");
    assert.match(summary.roles["ui-ux"].overlapsGeneral, /shares the General's claude-cli login/);
    assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /^\.nomarmy\.local\.yml$/m);
    assert.match(fs.readFileSync(path.join(repo, ".nomarmy.yml"), "utf8"), /ui-ux:\n\s+agent: grok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("army assign/general refuse a prefixed target, a role name with spaces, and an undefined General", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  try {
    assert.notEqual(runArmyCLI(root, repo, ["assign", "pm", "worker:codex", "--json"]).exitCode, 0);
    assert.notEqual(runArmyCLI(root, repo, ["assign", "Project Manager", "local", "--json"]).exitCode, 0);
    assert.notEqual(runArmyCLI(root, repo, ["general", "ghost", "--json"]).exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
