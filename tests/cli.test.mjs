// CLI integration tests for bin/nomarmy.mjs non-interactive (--json) paths.
// Spawns the real CLI as a subprocess against temporary scratch directories.

import "./helpers/isolate-global-config.mjs";
import { linkDir } from "./helpers/symlinks.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { PINNED_OPENCLAW_VERSION } from "../lib/openclaw-install.mjs";

import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(here, "..", "bin", "nomarmy.mjs");
const posixStubOnly = { skip: process.platform === "win32" ? "executes a POSIX shebang stub directly" : false };

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
  linkDir(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
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

function prepareSetupRoot() {
  // Real path: on macOS the temp folder is a symlink (/var -> /private/var),
  // and the CLI reports its own resolved location.
  const root = fs.realpathSync(scratchNomarmyRoot());
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "common.env"), "NOMARMY_EXISTING=kept\n");
  return root;
}

function runSetupCLI(root, args) {
  try {
    const result = execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "setup", ...args], {
      cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config") },
    });
    return { exitCode: 0, stdout: result, stderr: "" };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function runSetupCLIAsync(root, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "setup", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config") },
    }, (error, stdout, stderr) => resolve({ exitCode: error?.code ?? 0, stdout, stderr }));
  });
}

test("setup --hosted --json writes only hosted execution and returns the three next steps", () => {
  const root = prepareSetupRoot();
  try {
    const result = runSetupCLI(root, ["--hosted", "--json"]);
    assert.equal(result.exitCode, 0, result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), ["execution", "next", "written"]);
    assert.equal(output.written, path.join(root, "config", "common.env"));
    assert.equal(output.execution, "hosted");
    assert.deepEqual(output.next, [
      "nomarmy install",
      "nomarmy agents add",
      "nomarmy army init --agent <name>",
    ]);
    assert.equal(fs.readFileSync(output.written, "utf8"), "NOMARMY_EXISTING=kept\nNOMARMY_EXECUTION=hosted\nNOMARMY_SETUP_PROFILE=hosted\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup --llama-url --json writes remote llama settings and treats an offline server as a warning", async () => {
  const root = prepareSetupRoot();
  const temporary = http.createServer();
  await new Promise((resolve) => temporary.listen(0, "127.0.0.1", resolve));
  const port = temporary.address().port;
  await new Promise((resolve) => temporary.close(resolve));
  try {
    const result = runSetupCLI(root, ["--llama-url", `http://127.0.0.1:${port}`, "--json"]);
    assert.equal(result.exitCode, 0, result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), ["execution", "llamaHost", "llamaPort", "next", "reachable", "written"]);
    assert.deepEqual(output, {
      written: path.join(root, "config", "common.env"), execution: "remote", llamaHost: "127.0.0.1", llamaPort: String(port), reachable: false,
      next: "nomarmy install",
    });
    assert.equal(fs.readFileSync(output.written, "utf8"), `NOMARMY_EXISTING=kept\nNOMARMY_EXECUTION=remote\nNOMARMY_SETUP_PROFILE=remote\nNOMARMY_LLAMA_HOST=127.0.0.1\nNOMARMY_LLAMA_PORT=${port}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup --llama-url reports a reachable /health endpoint", async () => {
  const root = prepareSetupRoot();
  let requestedPath = null;
  const server = http.createServer((request, response) => {
    requestedPath = request.url;
    response.writeHead(200).end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const result = await runSetupCLIAsync(root, ["--llama-url", `http://127.0.0.1:${port}`, "--json"]);
    assert.equal(result.exitCode, 0, result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.reachable, true);
    assert.equal(requestedPath, "/health");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup rejects a bad llama URL and conflicting hosted flags without changing common.env", () => {
  const root = prepareSetupRoot();
  try {
    const commonPath = path.join(root, "config", "common.env");
    const before = fs.readFileSync(commonPath, "utf8");
    const bad = runSetupCLI(root, ["--llama-url", "not-a-url", "--json"]);
    assert.equal(bad.exitCode, 1);
    assert.match(JSON.parse(bad.stdout).error, /isn't a URL|use an http:\/\/ URL/);
    assert.equal(fs.readFileSync(commonPath, "utf8"), before);
    const conflict = runSetupCLI(root, ["--hosted", "--llama-url", "http://127.0.0.1:8080", "--json"]);
    assert.equal(conflict.exitCode, 1);
    assert.match(JSON.parse(conflict.stdout).error, /cannot be used together/);
    assert.equal(fs.readFileSync(commonPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    if (process.platform !== "win32") assert.equal((fs.statSync(path.join(root, "config", "agents.yml")).mode & 0o077), 0, "Unix mode bits keep agents.yml private");
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
    const clash = runAgentsCLI(root, ["add", "--json", "--name", "grok-sub", "--kind", "subscription", "--provider", "xai", "--model", "grok-4.7", "--owner", "owner@example.com"]);
    assert.notEqual(clash.exitCode, 0);
    assert.match(JSON.parse(clash.stdout).errors.join("\n"), /OpenClaw provider "xai" is used by both api agent grok and subscription agent grok-sub/);
    assert.deepEqual(Object.keys(JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout).agents), ["local", "grok"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents add --json --register (native api provider, e.g. xai) pipes the REAL key via stdin, never argv", posixStubOnly, () => {
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

test("agents add --json --register (custom endpoint) onboards with the REAL model/base_url, then pipes the key via stdin", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  const fake = withFakeOpenclaw(root);
  try {
    const { exitCode, stdout } = runAgentsCLI(root, [
      "add", "--json", "--register", "--name", "azure-mini", "--kind", "api", "--provider", "azure-openai",
      "--model", "gpt-4o-mini", "--auth-env", "NOMARMY_TEST_KEY_AZURE", "--base-url", "https://my-resource.openai.azure.com",
    ], { NOMARMY_TEST_KEY_AZURE: "sk-test-azure-secret", ...fake.env });
    assert.equal(exitCode, 0, stdout);
    const [onboardCall, pasteCall] = fake.calls();
    assert.ok(onboardCall.argv.some((a) => a === "https://my-resource.openai.azure.com") && onboardCall.argv.some((a) => a === "gpt-4o-mini"));
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

test("agents update applies its flags without --json, and prints a plain confirmation", () => {
  const root = scratchNomarmyRoot();
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]);
    const updated = runAgentsCLI(root, ["update", "codex", "--max-concurrent", "3"]);
    assert.equal(updated.exitCode, 0, updated.stdout);
    assert.match(updated.stdout, /Updated "codex"/);
    const listed = JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout);
    assert.equal((listed.agents ?? listed).codex.max_concurrent, 3);
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

test("scan --check renders drift as human text without object coercion", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-scan-drift-"));
  try {
    writeConfig(repo, 'verification:\n  quick:\n    commands: ["echo ok"]\n');
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"scan-drift","scripts":{"test":"node --test"}}\n');
    const result = runCLI(["scan", "--check", "--repo", repo]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "Comparing .nomarmy.yml against repository evidence\n\nDrift: 1 missing from config, 0 missing from repo (1 total)\n\n  repo has, config omits:  commandKinds: test\n");
    assert.doesNotMatch(result.stdout, /\[object Object\]/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// nomarmy army <init|assign|show>
// --------------------------------------------------------------------------
// NOMARMY_OPENCLAW_CMD points at nothing by default, so `army assign`'s
// model check never reaches a real OpenClaw (or spends a real request);
// a test that wants the check passes its own fake in extraEnv.
function runArmyCLI(root, repo, args, extraEnv = {}) {
  try {
    const result = execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "army", ...args, "--repo", repo], {
      cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config"), NOMARMY_OPENCLAW_CMD: path.join(root, "no-openclaw-here"), ...extraEnv },
    });
    return { exitCode: 0, stdout: result };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("army show outside a repository reports global settings without a root project layer", () => {
  const root = scratchNomarmyRoot();
  try {
    const shown = runArmyCLI(root, "/", ["show"]);
    assert.equal(shown.exitCode, 0, shown.stderr);
    assert.match(shown.stdout, /^🪖 nomArmy\nno repository here: showing global settings\n/);
    assert.doesNotMatch(shown.stdout, /🪖 nomArmy\s+\(\/\)/);
    assert.doesNotMatch(shown.stdout, /^  (project|local)\s/m);
    const machine = runArmyCLI(root, "/", ["show", "--json"]);
    assert.equal(machine.exitCode, 0, machine.stderr);
    assert.deepEqual(JSON.parse(machine.stdout).layers.map((layer) => layer.layer), ["global"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("army assign rejects roles absent from all rosters and allows cross-layer overrides", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-assign-empty-"));
  try {
    for (const layer of ["--local", "--project"]) {
      const result = runArmyCLI(root, repo, ["assign", "sr-dev", "codex", layer]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Role "sr-dev" is not defined in any army roster\. Run nomarmy army init first\./);
    }
    assert.equal(fs.existsSync(path.join(repo, ".nomarmy.local.yml")), false);
    assert.equal(fs.existsSync(path.join(repo, ".nomarmy.yml")), false);
    assert.equal(runArmyCLI(root, repo, ["init", "--json"]).exitCode, 0);
    const override = runArmyCLI(root, repo, ["assign", "sr-dev", "codex", "--project"]);
    assert.equal(override.exitCode, 0, override.stderr);
    assert.match(fs.readFileSync(path.join(repo, ".nomarmy.yml"), "utf8"), /sr-dev:\n\s+agent: codex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("army usage errors exit 1 and assignment flags may precede positionals", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-usage-"));
  try {
    for (const args of [["assign", "sr-dev"], ["assign", "sr-dev", "codex", "extra"], ["general"], ["assign", "--bogus", "sr-dev", "codex"]]) {
      const result = runArmyCLI(root, repo, args);
      assert.equal(result.exitCode, 1, args.join(" "));
    }
    assert.equal(runArmyCLI(root, repo, ["init", "--json"]).exitCode, 0);
    const assigned = runArmyCLI(root, repo, ["assign", "--local", "sr-dev", "codex"]);
    assert.equal(assigned.exitCode, 0, assigned.stderr);
    assert.match(fs.readFileSync(path.join(repo, ".nomarmy.local.yml"), "utf8"), /sr-dev:\n\s+agent: codex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("army show prints each agent's usage reading", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  const state = mkdtempSync(path.join(tmpdir(), "nomarmy-army-state-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]);
    assert.equal(runArmyCLI(root, repo, ["init", "--agent", "codex", "--model", "gpt-6-astra", "--json"]).exitCode, 0);
    fs.writeFileSync(path.join(state, "usage-limits.json"), JSON.stringify({ openai: { source: "codex", plan: null, limitReached: false, observedAt: Date.now(),
      windows: [{ name: "week", usedPercent: 85, windowMinutes: 10080, resetsAt: Date.now() + 86400000 }] } }));
    const shown = runArmyCLI(root, repo, ["show"], { NOMARMY_AGENT_STATE: state, NO_COLOR: "1" });
    assert.equal(shown.exitCode, 0, shown.stderr);
    assert.match(shown.stdout, /usage: 85% of week, resets/);
  } finally {
    for (const dir of [root, repo, state]) rmSync(dir, { recursive: true, force: true });
  }
});

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

test("army init --agent puts every role on a defined agent, uses auto without a default, accepts an explicit model, and refuses unknown agents", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-agent-init-"));
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]);
    const initialized = runArmyCLI(root, repo, ["init", "--agent", "codex", "--json"]);
    assert.equal(initialized.exitCode, 0, initialized.stdout);
    const initOutput = JSON.parse(initialized.stdout);
    assert.deepEqual(Object.keys(initOutput).sort(), ["layer", "roles", "written"]);
    let roles = JSON.parse(runArmyCLI(root, repo, ["show", "--json"]).stdout).roles;
    assert.deepEqual(Object.keys(roles).sort(), ["data-architect", "jr-dev", "pm", "po", "security-analyst", "sr-dev", "stakeholder", "ui-ux"]);
    for (const role of Object.values(roles)) {
      assert.equal(role.agent, "codex");
      assert.equal(role.model, "auto");
      assert.equal(role.modelIsAuto, true);
    }

    const explicit = runArmyCLI(root, repo, ["init", "--agent", "codex", "--model", "gpt-6-astra", "--force", "--json"]);
    assert.equal(explicit.exitCode, 0, explicit.stdout);
    roles = JSON.parse(runArmyCLI(root, repo, ["show", "--json"]).stdout).roles;
    for (const role of Object.values(roles)) {
      assert.equal(role.agent, "codex");
      assert.equal(role.model, "gpt-6-astra");
      assert.equal(role.modelIsAuto, false);
    }

    const unknownRepo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-agent-unknown-"));
    try {
      const unknown = runArmyCLI(root, unknownRepo, ["init", "--agent", "ghost", "--project", "--json"]);
      assert.equal(unknown.exitCode, 1);
      assert.match(JSON.parse(unknown.stdout).error, /Unknown agent "ghost"\. Pick one of: local, codex/);
      assert.equal(fs.existsSync(path.join(unknownRepo, ".nomarmy.yml")), false);
    } finally {
      rmSync(unknownRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("army init --agent warns when the selected agent runs tools on the host", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-agent-warning-"));
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "claude", "--kind", "subscription", "--provider", "claude-cli", "--model", "claude-sonnet-5", "--owner", "you@example.com"]);
    const result = runArmyCLI(root, repo, ["init", "--agent", "claude"]);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /runs its tools on the host\. Build roles on it will be refused unless allow_host_tools is set/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("army assign <role> <agent> <model|auto>: the model lands on the role, and a later reassignment clears it", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]);
    runAgentsCLI(root, ["add", "--json", "--name", "grok", "--kind", "api", "--provider", "xai", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY"]);
    runArmyCLI(root, repo, ["init", "--json"]);
    assert.equal(runArmyCLI(root, repo, ["assign", "sr-dev", "codex", "gpt-6-astra", "--json"]).exitCode, 0);
    assert.equal(runArmyCLI(root, repo, ["assign", "pm", "codex", "auto", "--json"]).exitCode, 0);
    assert.equal(runArmyCLI(root, repo, ["assign", "ui-ux", "codex", "--json"]).exitCode, 0);
    let roles = JSON.parse(runArmyCLI(root, repo, ["show", "--json"]).stdout).roles;
    assert.equal(roles["sr-dev"].model, "gpt-6-astra");
    assert.equal(roles.pm.modelIsAuto, true);
    assert.match(roles["ui-ux"].problem, /has no default model, so this role needs one/);
    runArmyCLI(root, repo, ["assign", "sr-dev", "grok", "--json"]);
    roles = JSON.parse(runArmyCLI(root, repo, ["show", "--json"]).stdout).roles;
    assert.equal(roles["sr-dev"].model, "grok-4.7", "the old role model is gone; grok's default applies");
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

// A fake openclaw whose catalog lists only openai/gpt-6-astra, and whose
// test calls fail -- the exact shape of the live gpt-6-sol surprise.
function withCatalogOpenclaw(root) {
  const scriptPath = path.join(root, ".fake-catalog-openclaw");
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "models" && args[1] === "list") { console.log("openai/gpt-6-astra   text+image 272k   no   yes"); process.exit(0); }
if (args[0] === "agent") { const ok = args.includes("openai/gpt-6-astra") && !args.includes("--isolated") && args.includes("--state-dir"); /* a job's route: --isolated skips the Codex runtime jobs use */ console.log(JSON.stringify(ok ? { ok: true, status: "ok", final: "ok" } : { ok: false, status: "error", final: "", error: { message: "Unknown model" } })); process.exit(0); }
process.exit(0);
`);
  fs.chmodSync(scriptPath, 0o755);
  return { NOMARMY_OPENCLAW_CMD: scriptPath };
}

test("army assign checks a named model: listed is accepted, unlisted-and-failing is refused without writing, --no-check skips", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]);
    const absent = runArmyCLI(root, repo, ["assign", "sr-dev", "codex", "--no-check", "--json"]);
    assert.equal(absent.exitCode, 1);
    assert.match(JSON.parse(absent.stdout).error, /Role "sr-dev" is not defined in any army roster/);
    assert.equal(runArmyCLI(root, repo, ["init", "--json"]).exitCode, 0);
    const fake = withCatalogOpenclaw(root);
    const ok = runArmyCLI(root, repo, ["assign", "sr-dev", "codex", "gpt-6-astra", "--json"], fake);
    assert.equal(ok.exitCode, 0, ok.stdout);
    assert.equal(JSON.parse(ok.stdout).modelCheck.status, "listed");
    const bad = runArmyCLI(root, repo, ["assign", "po", "codex", "gpt-6-sol", "--json"], fake);
    assert.notEqual(bad.exitCode, 0);
    assert.match(JSON.parse(bad.stdout).error, /codex\/gpt-6-sol isn't in OpenClaw's catalog and a real test call to it failed \(Unknown model\) -- nothing was written\. Pick a model from: gpt-6-astra/);
    // The Muse case: listed, but it doesn't run.
    fs.writeFileSync(fake.NOMARMY_OPENCLAW_CMD, fs.readFileSync(fake.NOMARMY_OPENCLAW_CMD, "utf8").replace('"openai/gpt-6-astra   text+image 272k   no   yes"', '"openai/gpt-6-astra   text+image 272k   no   yes\\nopenai/gpt-6-broken   text 272k   no   yes"'));
    const listedButBroken = runArmyCLI(root, repo, ["assign", "pm", "codex", "gpt-6-broken", "--json"], fake);
    assert.notEqual(listedButBroken.exitCode, 0);
    assert.match(JSON.parse(listedButBroken.stdout).error, /is listed in OpenClaw's catalog, but a real test call to it failed/);
    assert.equal(JSON.parse(runArmyCLI(root, repo, ["show", "--json"]).stdout).roles.po.agent, "local", "the refused assignment wrote nothing");
    assert.equal(runArmyCLI(root, repo, ["assign", "po", "codex", "gpt-6-sol", "--no-check", "--json"], fake).exitCode, 0);
    assert.equal(JSON.parse(runArmyCLI(root, repo, ["assign", "pm", "codex", "auto", "--json"], fake).stdout).modelCheck.status, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agents list --json shows which roles, and the General, use each agent", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]);
    runAgentsCLI(root, ["add", "--json", "--name", "claude", "--kind", "subscription", "--provider", "claude-cli", "--owner", "you@example.com"]);
    runArmyCLI(root, repo, ["init", "--json"]);
    runArmyCLI(root, repo, ["assign", "sr-dev", "codex", "gpt-6-astra", "--json"]);
    runArmyCLI(root, repo, ["general", "claude", "--json"]);
    const list = JSON.parse(execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "agents", "list", "--json", "--repo", repo], {
      cwd: repo, encoding: "utf8", env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config") },
    }));
    assert.deepEqual(list.assignments.codex, { general: false, roles: [{ role: "sr-dev", model: "gpt-6-astra" }] });
    assert.equal(list.assignments.claude.general, true);
    assert.ok(list.assignments.local.roles.some((r) => r.role === "jr-dev"), "the default roster's local roles");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agents update --json --no-model clears a default model; --model and --no-model together are refused", () => {
  const root = scratchNomarmyRoot();
  try {
    runAgentsCLI(root, ["add", "--json", "--name", "claude", "--kind", "subscription", "--provider", "claude-cli", "--model", "claude-opus-5-5", "--owner", "you@example.com"]);
    const cleared = runAgentsCLI(root, ["update", "claude", "--json", "--no-model"]);
    assert.equal(cleared.exitCode, 0, cleared.stdout);
    assert.equal(JSON.parse(cleared.stdout).agent.model, undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "config", "agents.yml"), "utf8"), /model:/);
    assert.notEqual(runAgentsCLI(root, ["update", "claude", "--json", "--no-model", "--model", "x"]).exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jobs --prune removes runtime data only from finished jobs past the age cutoff, keeping records", () => {
  const state = mkdtempSync(path.join(tmpdir(), "nomarmy-prune-"));
  try {
    const mk = (id, finishedAt, running = false) => {
      const d = path.join(state, "jobs", id);
      fs.mkdirSync(path.join(d, "runtime", "npm-cache"), { recursive: true });
      fs.writeFileSync(path.join(d, "runtime", "npm-cache", "blob"), "x".repeat(1000));
      fs.writeFileSync(path.join(d, "status.json"), JSON.stringify({ jobId: id, state: running ? "running" : "finished", serverPid: running ? process.pid : 0, updatedAt: finishedAt }));
      if (!running) fs.writeFileSync(path.join(d, "metadata.json"), JSON.stringify({ outcome: "WORKER_DONE", finishedAt }));
    };
    mk("old-done", new Date(Date.now() - 5 * 86400000).toISOString());
    mk("new-done", new Date().toISOString());
    mk("still-running", new Date(Date.now() - 5 * 86400000).toISOString(), true);
    const out = JSON.parse(execFileSync(process.execPath, [CLI_PATH, "jobs", "--prune", "--json"], { encoding: "utf8", env: { ...process.env, NOMARMY_AGENT_STATE: state } }));
    assert.equal(out.pruned, 1);
    assert.equal(fs.existsSync(path.join(state, "jobs", "old-done", "runtime")), false);
    assert.equal(fs.existsSync(path.join(state, "jobs", "old-done", "metadata.json")), true, "the record stays");
    assert.equal(fs.existsSync(path.join(state, "jobs", "new-done", "runtime")), true, "too recent");
    assert.equal(fs.existsSync(path.join(state, "jobs", "still-running", "runtime")), true, "never a running job");
    // --older-than 0: a live job's heartbeat is in the past too, and must
    // never make it look finished (this deleted a running job's state).
    mk("live-now", new Date(Date.now() - 60000).toISOString(), true);
    mk("leased", new Date(Date.now() - 60000).toISOString());
    fs.mkdirSync(path.join(state, "leases"), { recursive: true });
    fs.writeFileSync(path.join(state, "leases", "leased.json"), JSON.stringify({ jobId: "leased", pid: process.pid }));
    const all = JSON.parse(execFileSync(process.execPath, [CLI_PATH, "jobs", "--prune", "--older-than", "0", "--json"], { encoding: "utf8", env: { ...process.env, NOMARMY_AGENT_STATE: state } }));
    assert.equal(all.pruned, 1, "only new-done");
    assert.equal(fs.existsSync(path.join(state, "jobs", "new-done", "runtime")), false);
    for (const id of ["still-running", "live-now", "leased"]) assert.equal(fs.existsSync(path.join(state, "jobs", id, "runtime")), true, id);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

function runJobsWait(state, jobId, extraArgs = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_PATH, "jobs", "--wait", jobId, ...extraArgs], {
      encoding: "utf8", env: { ...process.env, NOMARMY_AGENT_STATE: state },
    }, (error, stdout, stderr) => resolve({ exitCode: error?.code ?? 0, stdout, stderr }));
  });
}

test("jobs --wait returns an already-finished job with the exact JSON contract and exit status", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "nomarmy-wait-finished-"));
  try {
    const dir = path.join(state, "jobs", "done-job");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "finished" }));
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({
      outcome: "WORKER_DONE", coordinatorStatus: "complete", branch: "worker/done-job",
      commit: { sha: "abc123" }, issues: [],
    }));
    const result = await runJobsWait(state, "done-job", ["--json"]);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output), ["jobId", "outcome", "coordinatorStatus", "branch", "commit", "issues"]);
    assert.deepEqual(output, { jobId: "done-job", outcome: "WORKER_DONE", coordinatorStatus: "complete", branch: "worker/done-job", commit: "abc123", issues: [] });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("jobs --wait blocks for a running job, then reports the first issue and exits 1", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "nomarmy-wait-running-"));
  try {
    const dir = path.join(state, "jobs", "running-job");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "running" }));
    const startedAt = Date.now();
    const pending = runJobsWait(state, "running-job", ["--timeout", "5"]);
    setTimeout(() => {
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "finished" }));
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({
        outcome: "NEEDS_REVIEW", coordinatorStatus: "needs_review", issues: ["first problem", "second problem"],
      }));
    }, 600);
    const result = await pending;
    assert.ok(Date.now() - startedAt >= 550, "the command stayed blocked until the delayed result was written");
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.trim(), "running-job NEEDS_REVIEW needs_review issue=first problem");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("jobs --wait exits 2 for an unknown job and a timeout", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "nomarmy-wait-errors-"));
  try {
    const unknown = await runJobsWait(state, "missing", ["--json"]);
    assert.equal(unknown.exitCode, 2);
    assert.deepEqual(JSON.parse(unknown.stdout), { error: "unknown job id: missing" });
    const dir = path.join(state, "jobs", "slow-job");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "running" }));
    const timedOut = await runJobsWait(state, "slow-job", ["--timeout", "0", "--json"]);
    assert.equal(timedOut.exitCode, 2);
    assert.deepEqual(JSON.parse(timedOut.stdout), { error: "timed out waiting for job slow-job" });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

// A pseudo-terminal drives the real interactive wizard while every external
// login and probe is a local stub. No vendor CLI or network is contacted.
function fakeExecutable(root, name, body) {
  const file = path.join(root, "bin", name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runInteractiveAgents(root, args, replies, env = {}) {
  return new Promise((resolve, reject) => {
    const cli = path.join(root, "bin", "nomarmy.mjs");
    const command = [process.execPath, cli, "agents", ...args].map((x) => `'${x.replaceAll("'", "'\\''")}'`).join(" ");
    const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], {
      cwd: root, env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, NOMARMY_CONFIG_DIR: path.join(root, "config"), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", sent = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Interactive agents stalled after ${sent}/${replies.length} replies. Output: ${stdout}`));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (sent < replies.length && stdout.includes(replies[sent][0])) child.stdin.write(replies[sent++][1] + "\n");
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr, sent }); });
  });
}

const ttyOnly = { skip: posixStubOnly.skip || (process.platform !== "linux" ? "requires Linux script PTY" : false) };

test("agents add subscription vendor sign-in failure stops before model and writes nothing", ttyOnly, async () => {
  for (const vendor of ["claude", "codex", "meta"]) {
    const root = scratchNomarmyRoot();
    const bin = { claude: "claude", codex: "codex", meta: "muse" }[vendor];
    try {
      fakeExecutable(root, bin, `const a=process.argv.slice(2).join(" "); if(a==="--version") process.exit(0); if(a==="auth status") console.log(JSON.stringify({loggedIn:false})); if(a==="login status") console.log("Not logged in"); if(a==="auth login"||a==="login") process.exit(1);`);
      const result = await runInteractiveAgents(root, ["add", "subscription", vendor], [["Log in now?", "y"]]);
      assert.equal(result.exitCode, 1, result.stdout);
      assert.equal(result.sent, 1);
      assert.match(result.stdout, new RegExp(`Retry with .nomarmy agents add subscription ${vendor}`));
      assert.doesNotMatch(result.stdout, /Default model|Whose subscription|Agent name/);
      assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("agents add subscription owner defaults to signed-in email and re-asks invalid answer", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    fakeExecutable(root, "claude", `const a=process.argv.slice(2).join(" "); if(a==="--version") process.exit(0); if(a==="auth status") console.log(JSON.stringify({loggedIn:true,email:"signed@example.com"}));`);
    const openclaw = fakeExecutable(root, "fake-openclaw", `const a=process.argv.slice(2).join(" "); if(a.startsWith("models list")) console.log("claude-cli/sonnet   text"); if(a.startsWith("agent exec")) console.log(JSON.stringify({ok:true,final:"ok"}));`);
    const result = await runInteractiveAgents(root, ["add", "subscription", "claude"], [
      ["Default model", ""], ["Whose subscription is this", "not-an-email"],
      ["enter an email address", "signed@example.com"], ["Agent name", ""],
    ], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.sent, 4, result.stdout);
    assert.match(result.stdout, /Whose subscription is this \[signed@example.com\]/);
    const agent = JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout).agents.claude;
    assert.equal(agent.owner, "signed@example.com");
    assert.equal(agent.provider, "claude-cli");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add --json rejects invalid --owner naming the flag", () => {
  const root = scratchNomarmyRoot();
  try {
    const result = runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "bad owner"]);
    assert.equal(result.exitCode, 1);
    assert.match(JSON.parse(result.stdout).error, /--owner must be an email address/);
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents update codex --probe uses the first assigned role model without an agent default", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  try {
    assert.equal(runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]).exitCode, 0);
    writeConfig(root, "army:\n  roles:\n    sr-dev:\n      agent: codex\n      model: gpt-6-sol\n");
    const marker = path.join(root, "probed-model");
    const openclaw = fakeExecutable(root, "fake-openclaw", `import fs from "node:fs"; const a=process.argv.slice(2); if(a[0]==="agent") { fs.writeFileSync(${JSON.stringify(marker)}, a[a.indexOf("--model")+1]); console.log(JSON.stringify({ok:true,final:"ok"})); }`);
    const result = runAgentsCLI(root, ["update", "codex", "--probe"], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /^✓ codex  openai\/gpt-6-sol \(sr-dev's model\)  answered in [0-9.]+s\n$/);
    assert.equal(fs.readFileSync(marker, "utf8"), "openai/gpt-6-sol");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents update --probe uses the vendor default when no role assigns a model", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  try {
    assert.equal(runAgentsCLI(root, ["add", "--json", "--name", "codex", "--kind", "subscription", "--provider", "openai", "--owner", "you@example.com"]).exitCode, 0);
    const marker = path.join(root, "probed-model");
    const openclaw = fakeExecutable(root, "fake-openclaw", `import fs from "node:fs"; const a=process.argv.slice(2); if(a[0]==="agent") { fs.writeFileSync(${JSON.stringify(marker)}, a[a.indexOf("--model")+1]); console.log(JSON.stringify({ok:true,final:"ok"})); }`);
    const result = runAgentsCLI(root, ["update", "--probe"], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /^✓ codex  openai\/gpt-6-astra \(vendor default\)  answered in [0-9.]+s\n$/);
    assert.equal(fs.readFileSync(marker, "utf8"), "openai/gpt-6-astra");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents update --probe uses the first catalog model when no role or vendor default exists", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  try {
    assert.equal(runAgentsCLI(root, ["add", "--json", "--name", "claude", "--kind", "subscription", "--provider", "claude-cli", "--owner", "you@example.com"]).exitCode, 0);
    const marker = path.join(root, "probed-model");
    const openclaw = fakeExecutable(root, "fake-openclaw", `import fs from "node:fs"; const a=process.argv.slice(2); if(a[0]==="models") console.log("claude-cli/sonnet   text\\nclaude-cli/opus   text"); if(a[0]==="agent") { fs.writeFileSync(${JSON.stringify(marker)}, a[a.indexOf("--model")+1]); console.log(JSON.stringify({ok:true,final:"ok"})); }`);
    const result = runAgentsCLI(root, ["update", "claude", "--probe"], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /^✓ claude  claude-cli\/sonnet \(first catalog model\)  answered in [0-9.]+s\n$/);
    assert.equal(fs.readFileSync(marker, "utf8"), "claude-cli/sonnet");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents update --probe fails with a model-setting command only when no model can be found", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  try {
    assert.equal(runAgentsCLI(root, ["add", "--json", "--name", "claude", "--kind", "subscription", "--provider", "claude-cli", "--owner", "you@example.com"]).exitCode, 0);
    const marker = path.join(root, "probed-model");
    const openclaw = fakeExecutable(root, "fake-openclaw", `import fs from "node:fs"; const a=process.argv.slice(2); if(a[0]==="agent") fs.writeFileSync(${JSON.stringify(marker)}, "called");`);
    const result = runAgentsCLI(root, ["update", "claude", "--probe"], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.stdout, "✗ claude  claude-cli/no model  no model available; set one with `nomarmy agents update claude --model <m>`\n");
    assert.equal(fs.existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents update --probe probes every configured agent, prints outcomes and fails on any failure", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  try {
    for (const [name, provider, model] of [["codex", "openai", "gpt-6-astra"], ["claude", "claude-cli", "sonnet"]]) {
      assert.equal(runAgentsCLI(root, ["add", "--json", "--name", name, "--kind", "subscription", "--provider", provider, "--model", model, "--owner", "you@example.com"]).exitCode, 0);
    }
    const openclaw = fakeExecutable(root, "fake-openclaw", `const a=process.argv.slice(2).join(" "); if(a.includes("claude-cli/sonnet")) console.log(JSON.stringify({ok:false,message:"denied"})); else console.log(JSON.stringify({ok:true,final:"ok"}));`);
    const result = runAgentsCLI(root, ["update", "--probe"], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stdout, /✓ codex  openai\/gpt-6-astra  answered in [0-9.]+s/);
    assert.match(result.stdout, /✗ claude  claude-cli\/sonnet  failed: denied/);
    assert.equal(result.stdout.trim().split("\n").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fakeCodexSubscription(root, profiles, probeOk = false, probeMessage = "model refused") {
  fakeExecutable(root, "codex", `const a=process.argv.slice(2).join(" "); if(a==="--version") process.exit(0); if(a==="login status") console.log("Logged in using ChatGPT");`);
  const probeMarker = path.join(root, "probed");
  const probeBody = probeOk ? { ok: true, final: "ok" } : { ok: false, message: probeMessage };
  const openclaw = fakeExecutable(root, "fake-openclaw", `import fs from "node:fs"; const a=process.argv.slice(2).join(" "); if(a==="--version") console.log("OpenClaw ${PINNED_OPENCLAW_VERSION}"); if(a.startsWith("plugins inspect")) console.log(JSON.stringify({plugin:{enabled:true,builtWithOpenClawVersion:"${PINNED_OPENCLAW_VERSION}"}})); if(a==="update status --json") console.log(JSON.stringify({migrationWarnings:[]})); if(a.startsWith("models list")) console.log("openai/gpt-6-astra   text"); if(a==="models auth list --json") console.log(JSON.stringify({profiles:${JSON.stringify(profiles)}})); if(a.startsWith("models auth login")) process.exit(0); if(a.startsWith("agent exec")) { fs.writeFileSync(${JSON.stringify(probeMarker)}, "called"); console.log(JSON.stringify(${JSON.stringify(probeBody)})); }`);
  return { env: { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") }, probeMarker };
}

const codexDetails = [["Default model", ""], ["Whose subscription is this", "person@example.com"], ["Agent name", ""]];

test("agents add subscription declines an older OpenClaw without running npm or writing config", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    fakeExecutable(root, "codex", `const a=process.argv.slice(2).join(" "); if(a==="--version") process.exit(0); if(a==="login status") console.log("Logged in using ChatGPT");`);
    const openclaw = fakeExecutable(root, "fake-openclaw", `if(process.argv.slice(2).join(" ")==="--version") console.log("OpenClaw 2026.9.5");`);
    const npmMarker = path.join(root, "npm-called");
    fakeExecutable(root, "npm", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(npmMarker)}, process.argv.slice(2).join(" "));`);
    const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], [["Apply these changes?", "no"]], {
      NOMARMY_OPENCLAW_CMD: openclaw,
    });
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.sent, 1, result.stdout);
    assert.match(result.stdout, /Upgrade OpenClaw to 2026\.9\.6/);
    assert.match(result.stdout, /Apply these changes\? \[y\/N\]/);
    assert.match(result.stdout, /No changes made\./);
    assert.doesNotMatch(result.stdout, /Default model|Whose subscription|Agent name/);
    assert.equal(fs.existsSync(npmMarker), false);
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription codex stops before prompts when OpenClaw auth profile is missing", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    const { env, probeMarker } = fakeCodexSubscription(root, []);
    const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], codexDetails, env);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.sent, 0);
    assert.match(result.stdout, /no usable auth profile.*nomarmy agents add subscription codex/);
    assert.doesNotMatch(result.stdout, /Default model|Whose subscription|Agent name|Save the agent anyway/);
    assert.equal(fs.existsSync(probeMarker), false);
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription codex stops before prompts when OpenClaw auth profile is expired", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    const { env, probeMarker } = fakeCodexSubscription(root, [{ id: "openai:expired", provider: "openai", type: "oauth", expiresAt: "2020-01-01T00:00:00.000Z" }]);
    const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], codexDetails, env);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.sent, 0);
    assert.match(result.stdout, /no usable auth profile.*nomarmy agents add subscription codex/);
    assert.doesNotMatch(result.stdout, /Default model|Whose subscription|Agent name|Save the agent anyway/);
    assert.equal(fs.existsSync(probeMarker), false);
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription codex stops as a sign-in failure when a valid profile still probes 401", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    const { env, probeMarker } = fakeCodexSubscription(root, [{ id: "openai:working", provider: "openai", type: "oauth", expiresAt: "2099-01-01T00:00:00.000Z" }], false, "401 Unauthorized");
    const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], codexDetails, env);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.sent, 3, result.stdout);
    assert.match(result.stdout, /Sign-in failed: 401 Unauthorized/);
    assert.match(result.stdout, /fix: openclaw migrate apply codex --from ~\/\.codex --agent main --include-secrets --item auth:openai --yes to re-import the Codex login \(preview with `openclaw migrate plan codex --from ~\/\.codex --agent main --include-secrets --item auth:openai`\), or `openclaw configure` \(Model Setup, select Codex\) in a terminal/);
    assert.doesNotMatch(result.stdout, /Save the agent anyway|login works|nomarmy agents add/);
    assert.equal(fs.readFileSync(probeMarker, "utf8"), "called");
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription codex treats missing bearer, no usable profiles, and an unavailable profile as sign-in failures", ttyOnly, async () => {
  for (const message of ["Missing bearer", "no usable profiles", "Selected auth profile openai:codex is unavailable"]) {
    const root = scratchNomarmyRoot();
    try {
      const { env, probeMarker } = fakeCodexSubscription(root, [{ id: "openai:working", provider: "openai", type: "oauth", expiresAt: "2099-01-01T00:00:00.000Z" }], false, message);
      const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], codexDetails, env);
      assert.equal(result.exitCode, 1, `${message}\n${result.stdout}`);
      assert.equal(result.sent, 3, result.stdout);
      assert.match(result.stdout, new RegExp(`Sign-in failed: ${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(result.stdout, /openclaw migrate apply codex --from ~\/\.codex --agent main --include-secrets --item auth:openai --yes/);
      assert.match(result.stdout, /openclaw migrate plan codex --from ~\/\.codex --agent main --include-secrets --item auth:openai/);
      assert.match(result.stdout, /openclaw configure` \(Model Setup, select Codex\) in a terminal/);
      assert.doesNotMatch(result.stdout, /Save the agent anyway|login works|nomarmy agents add/);
      assert.equal(fs.readFileSync(probeMarker, "utf8"), "called");
      assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("agents add subscription codex offers default-no save when profile works but model fails", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    const { env, probeMarker } = fakeCodexSubscription(root, [{ id: "openai:working", provider: "openai", type: "oauth", expiresAt: "2099-01-01T00:00:00.000Z" }]);
    const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], [...codexDetails, ["Save the agent anyway?", ""]], env);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(result.sent, 4, result.stdout);
    assert.match(result.stdout, /login works, but openai\/gpt-6-astra didn't answer/);
    assert.match(result.stdout, /nomarmy agents update codex --probe/);
    assert.match(result.stdout, /Save the agent anyway\? \[y\/N\]/);
    assert.doesNotMatch(result.stdout, /Sign-in has no usable auth profile/);
    assert.equal(fs.readFileSync(probeMarker, "utf8"), "called");
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription codex saves on yes despite a failed model call", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    const { env, probeMarker } = fakeCodexSubscription(root, [{ id: "openai:working", provider: "openai", type: "oauth" }]);
    const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], [...codexDetails, ["Save the agent anyway?", "yes"]], env);
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.sent, 4, result.stdout);
    assert.match(result.stdout, /login works, but openai\/gpt-6-astra didn't answer/);
    assert.equal(fs.readFileSync(probeMarker, "utf8"), "called");
    assert.deepEqual(JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout).agents.codex,
      { kind: "subscription", provider: "openai", owner: "person@example.com", max_concurrent: 1, thinking: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription owner falls back to repo git email", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    fakeExecutable(root, "claude", `const a=process.argv.slice(2).join(" "); if(a==="--version") process.exit(0); if(a==="auth status") console.log(JSON.stringify({loggedIn:true}));`);
    fakeExecutable(root, "git", `if(process.argv.slice(2).join(" ")==="config user.email") console.log("repo@example.com");`);
    const openclaw = fakeExecutable(root, "fake-openclaw", `const a=process.argv.slice(2).join(" "); if(a.startsWith("models list")) console.log("claude-cli/sonnet   text"); if(a.startsWith("agent exec")) console.log(JSON.stringify({ok:true,final:"ok"}));`);
    const result = await runInteractiveAgents(root, ["add", "subscription", "claude"], [
      ["Default model", ""], ["Whose subscription is this", "repo@example.com"], ["Agent name", ""],
    ], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(result.sent, 3);
    assert.match(result.stdout, /Whose subscription is this \[repo@example.com\]/);
    assert.equal(JSON.parse(runAgentsCLI(root, ["list", "--json"]).stdout).agents.claude.owner, "repo@example.com");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription codex rejects a nonzero login even when status looks signed in afterward", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    const marker = path.join(root, "login-attempted");
    fakeExecutable(root, "codex", `import fs from "node:fs"; const a=process.argv.slice(2).join(" "); if(a==="--version") process.exit(0); if(a==="login status") console.log(fs.existsSync(${JSON.stringify(marker)}) ? "Logged in using ChatGPT" : "Not logged in"); if(a==="login") { fs.writeFileSync(${JSON.stringify(marker)}, "attempted"); process.exit(1); }`);
    const result = await runInteractiveAgents(root, ["add", "subscription", "codex"], [["Log in now?", "y"], ["Update OpenClaw now", "n"]]);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stdout, /codex sign-in failed or was canceled.*nomarmy agents add subscription codex/);
    assert.doesNotMatch(result.stdout, /Models|Default model|Whose subscription|Agent name/);
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents update --probe alone prints a passing line for every successful configured agent", posixStubOnly, () => {
  const root = scratchNomarmyRoot();
  try {
    for (const [name, provider, model] of [["codex", "openai", "gpt-6-astra"], ["claude", "claude-cli", "sonnet"]]) {
      assert.equal(runAgentsCLI(root, ["add", "--json", "--name", name, "--kind", "subscription", "--provider", provider, "--model", model, "--owner", "you@example.com"]).exitCode, 0);
    }
    const openclaw = fakeExecutable(root, "fake-openclaw", `console.log(JSON.stringify({ok:true,final:"ok"}));`);
    const result = runAgentsCLI(root, ["update", "--probe"], { NOMARMY_OPENCLAW_CMD: openclaw, NOMARMY_AGENT_STATE: path.join(root, "state") });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /^✓ codex  openai\/gpt-6-astra  answered in [0-9.]+s\n✓ claude  claude-cli\/sonnet  answered in [0-9.]+s\n$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agents add subscription cancellation exits nonzero before model prompts", ttyOnly, async () => {
  const root = scratchNomarmyRoot();
  try {
    fakeExecutable(root, "claude", `const a=process.argv.slice(2).join(" "); if(a==="--version") process.exit(0); if(a==="auth status") console.log(JSON.stringify({loggedIn:false}));`);
    const result = await runInteractiveAgents(root, ["add", "subscription", "claude"], [["Log in now?", "n"]]);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stdout, /Sign-in canceled.*nomarmy agents add subscription claude/);
    assert.doesNotMatch(result.stdout, /Default model|Whose subscription|Agent name/);
    assert.equal(fs.existsSync(path.join(root, "config", "agents.yml")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("jobs --wait reports multiple comma-separated and positional jobs as each finishes", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "nomarmy-wait-many-"));
  try {
    for (const id of ["first", "second", "third"]) {
      const dir = path.join(state, "jobs", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "running" }));
    }
    const finish = (id) => {
      const dir = path.join(state, "jobs", id);
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ outcome: "WORKER_DONE", coordinatorStatus: "complete" }));
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "finished" }));
    };
    const pending = runJobsWait(state, "first,second", ["third", "--timeout", "8"]);
    setTimeout(() => finish("second"), 200);
    setTimeout(() => finish("first"), 2400);
    setTimeout(() => finish("third"), 4600);
    const result = await pending;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "second WORKER_DONE complete\nfirst WORKER_DONE complete\nthird WORKER_DONE complete");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("jobs --wait rejects an unknown id in a list and returns failure after all known jobs finish", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "nomarmy-wait-many-errors-"));
  try {
    for (const [id, outcome, coordinatorStatus] of [["good", "WORKER_DONE", "complete"], ["bad", "NEEDS_REVIEW", "needs_review"]]) {
      const dir = path.join(state, "jobs", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "finished" }));
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ outcome, coordinatorStatus }));
    }
    const unknown = await runJobsWait(state, "good", ["missing", "bad"]);
    assert.equal(unknown.exitCode, 2);
    assert.equal(unknown.stderr.trim(), "nomarmy jobs: unknown job id: missing");
    assert.equal(unknown.stdout, "");
    const failed = await runJobsWait(state, "good", ["bad"]);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.stdout.trim(), "good WORKER_DONE complete\nbad NEEDS_REVIEW needs_review");
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("jobs help names scoped waits and events", () => {
  const help = execFileSync(process.execPath, [CLI_PATH, "help"], { encoding: "utf8" });
  assert.match(help, /--wait <jobId> \[<jobId> \.\.\.\]/);
  assert.match(help, /--events --until-done --run <run-id>/);
  assert.match(help, /--events --repo <path>/);
  assert.match(help, /Unscoped\s+--until-done watches every job on this machine/);
});
