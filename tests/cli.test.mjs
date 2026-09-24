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

// `nomarmy providers` resolves config/providers.yml against nomarmyRoot (the
// CLI script's OWN location), not --repo/cwd -- the same way `setup`/`model`
// already resolve config/common.env. read-only subcommands (list/validate)
// are safe to exercise against the real checkout directly, since this repo
// ships no real config/providers.yml (only the .example template). The
// WRITE subcommands (add/remove) get their own tiny scratch copy of
// bin/+lib/+package.json (node_modules symlinked, not copied, to stay fast)
// so a test run never touches this actual repository's own files.

// A scratch root, not CLI_PATH/the real checkout directly: config/
// providers.yml is real, local, operator-written config (gitignored, not
// shipped) -- running these against the actual repo would pass or fail
// depending on whatever this developer happens to have configured on their
// own machine, which is exactly the kind of test flakiness a scratch root
// avoids.
test("providers list --json with no config/providers.yml reports found:false", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["list", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.found, false);
    assert.deepEqual(output.pools, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers validate --json with no config/providers.yml reports valid:true, found:false", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["validate", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.valid, true);
    assert.equal(output.found, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratchNomarmyRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "nomarmy-providers-cli-"));
  const repoRoot = path.join(here, "..");
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  fs.cpSync(path.join(repoRoot, "bin"), path.join(dir, "bin"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(dir, "package.json"));
  return dir;
}

function runProvidersCLI(root, args, extraEnv = {}) {
  try {
    const result = execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "providers", ...args], {
      // Each scratch root is its own "global" config dir, so tests never share one.
      cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config"), ...extraEnv },
    });
    return { exitCode: 0, stdout: result, stderr: "" };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// `nomarmy providers add --register` shells out to a real `openclaw`
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

test("providers add --json (llama-cpp) writes a valid config/providers.yml under a scratch nomarmyRoot", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    assert.equal(exitCode, 0, stdout);
    const written = JSON.parse(stdout);
    assert.equal(written.entry.id, "local");
    assert.ok(fs.existsSync(path.join(root, "config", "providers.yml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json --register (native provider, e.g. xai) pipes the REAL credential via stdin, never argv, using the real entry field names", () => {
  const root = scratchNomarmyRoot();
  const fake = withFakeOpenclaw(root);
  try {
    const { exitCode, stdout } = runProvidersCLI(root, [
      "add", "--json", "--register", "--pool", "capable", "--provider", "xai", "--id", "grok",
      "--model", "grok-build-0.1", "--auth-env", "NOMARMY_TEST_KEY_XAI",
    ], { ...fake.env, NOMARMY_TEST_KEY_XAI: "sk-test-real-secret-value" });
    assert.equal(exitCode, 0, stdout);
    const calls = fake.calls();
    assert.equal(calls.length, 1, "a native provider needs exactly one openclaw call (paste-api-key), no custom onboarding step");
    const [call] = calls;
    assert.deepEqual(call.argv.slice(0, 5), ["models", "auth", "paste-api-key", "--provider", "xai"]);
    assert.equal(call.stdin.trim(), "sk-test-real-secret-value", "the REAL key must be on stdin, not the string \"null\" or \"undefined\"");
    assert.ok(!call.argv.join(" ").includes("sk-test-real-secret-value"), "the credential must never appear in argv");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json --register (custom-endpoint provider) onboards with the REAL model/base_url, then pipes the REAL credential via stdin", () => {
  const root = scratchNomarmyRoot();
  const fake = withFakeOpenclaw(root);
  try {
    const { exitCode, stdout } = runProvidersCLI(root, [
      "add", "--json", "--register", "--pool", "capable", "--provider", "azure-openai", "--id", "azure-mini",
      "--model", "gpt-4o-mini", "--auth-env", "NOMARMY_TEST_KEY_AZURE", "--base-url", "https://my-resource.openai.azure.com",
    ], { NOMARMY_TEST_KEY_AZURE: "sk-test-azure-secret", ...fake.env });
    assert.equal(exitCode, 0, stdout);
    const calls = fake.calls();
    assert.equal(calls.length, 2, "a custom endpoint needs onboard (define the shape) THEN paste-api-key (attach the credential)");
    const [onboardCall, pasteCall] = calls;
    assert.ok(onboardCall.argv.includes("--custom-base-url") && onboardCall.argv.includes("https://my-resource.openai.azure.com"),
      "the REAL base_url must reach openclaw onboard, not undefined");
    assert.ok(onboardCall.argv.includes("--custom-model-id") && onboardCall.argv.includes("gpt-4o-mini"),
      "the REAL model must reach openclaw onboard, not undefined");
    assert.deepEqual(pasteCall.argv.slice(0, 3), ["models", "auth", "paste-api-key"]);
    assert.equal(pasteCall.stdin.trim(), "sk-test-azure-secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json (hosted provider) requires --auth-env, refuses cleanly without it", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "anthropic", "--id", "sonnet", "--model", "claude-sonnet-4-6"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).errors.join("\n"), /auth_env: is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json twice accumulates entries in the same pool, then list --json shows both", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "deepinfra", "--id", "deepinfra-llama", "--model", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "--auth-env", "NOMARMY_DEEPINFRA_API_KEY", "--weight", "3"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["list", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.pools.cheap.length, 2);
    assert.equal(output.pools.cheap[1].auth_set, false, "NOMARMY_DEEPINFRA_API_KEY is not set in the test env");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json writes a generic openclaw entry with its provider id and plugin", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "openclaw", "--openclaw-provider", "deepseek",
      "--plugin", "clawhub:@openclaw/deepseek-provider", "--id", "ds", "--model", "deepseek-chat", "--auth-env", "NOMARMY_DEEPSEEK_API_KEY"]);
    assert.equal(exitCode, 0, stdout);
    const listed = JSON.parse(runProvidersCLI(root, ["list", "--json"]).stdout);
    assert.equal(listed.pools.cheap[0].openclaw_provider, "deepseek");
    assert.equal(listed.pools.cheap[0].plugin, "clawhub:@openclaw/deepseek-provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json refuses a duplicate id across pools, and does not corrupt the existing file", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "anthropic", "--id", "local", "--model", "x", "--auth-env", "NOMARMY_X"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).errors.join("\n"), /already used by pool "cheap"/);
    const after = fs.readFileSync(path.join(root, "config", "providers.yml"), "utf8");
    assert.match(after, /cheap:/);
    assert.doesNotMatch(after, /capable:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json refuses \"__proto__\" as a pool name with a clear error, not a silently empty pools file", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "__proto__", "--provider", "llama-cpp", "--id", "local", "--weight", "1"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).error, /reserved/);
    assert.equal(fs.existsSync(path.join(root, "config", "providers.yml")), false, "a refused write must not create a partial file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers remove --json removes one entry; removing the last entry removes the whole pool", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["remove", "cheap", "local", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.removed, true);
    const after = fs.readFileSync(path.join(root, "config", "providers.yml"), "utf8");
    assert.doesNotMatch(after, /cheap:/, "an emptied pool must be removed entirely, not left as an empty list");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers remove --json on a nonexistent config/providers.yml refuses cleanly", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["remove", "cheap", "local", "--json"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).error, /No config\/providers\.yml exists yet/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json --context-window sets an explicit override; providers update --json changes it later", () => {
  const root = scratchNomarmyRoot();
  try {
    const added = runProvidersCLI(root, [
      "add", "--json", "--pool", "capable", "--provider", "xai", "--id", "grok",
      "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY", "--context-window", "500000",
    ]);
    assert.equal(added.exitCode, 0, added.stdout);
    assert.equal(JSON.parse(added.stdout).entry.context_window, 500000);

    const updated = runProvidersCLI(root, ["update", "capable", "grok", "--json", "--context-window", "400000"]);
    assert.equal(updated.exitCode, 0, updated.stdout);
    assert.equal(JSON.parse(updated.stdout).entry.context_window, 400000);

    const { stdout } = runProvidersCLI(root, ["list", "--json"]);
    assert.equal(JSON.parse(stdout).pools.capable[0].context_window, 400000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json with no --context-window leaves the field unset -- dispatch falls back to the openclaw catalog lookup, not a hardcoded default", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, [
      "add", "--json", "--pool", "capable", "--provider", "xai", "--id", "grok",
      "--model", "grok-4.6", "--auth-env", "NOMARMY_XAI_API_KEY",
    ]);
    assert.equal(exitCode, 0, stdout);
    assert.equal("context_window" in JSON.parse(stdout).entry, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers list (plain text) never prints 'thinking=undefined' for a llama-cpp entry, which has no thinking field at all", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["list"]);
    assert.equal(exitCode, 0, stdout);
    assert.doesNotMatch(stdout, /thinking=undefined/);
    assert.doesNotMatch(stdout, /thinking=/, "a llama-cpp entry has no per-entry thinking note at all -- it's governed by the separate global flag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers list (plain text) shows a fixed thinking level distinctly from the boolean pass-through case", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "xai", "--id", "grok", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY", "--thinking", "high"]);
    const { stdout } = runProvidersCLI(root, ["list"]);
    assert.match(stdout, /thinking=high \(fixed\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json --thinking <level> sets a fixed reasoning floor for the entry; a bare --thinking keeps the boolean pass-through meaning", () => {
  const root = scratchNomarmyRoot();
  try {
    const fixed = runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "xai", "--id", "grok", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY", "--thinking", "high"]);
    assert.equal(fixed.exitCode, 0, fixed.stdout);
    assert.equal(JSON.parse(fixed.stdout).entry.thinking, "high");

    const boolTrue = runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "openai", "--id", "gpt", "--model", "gpt-5.6", "--auth-env", "NOMARMY_OPENAI_API_KEY", "--thinking"]);
    assert.equal(boolTrue.exitCode, 0, boolTrue.stdout);
    assert.equal(JSON.parse(boolTrue.stdout).entry.thinking, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers update --json --thinking <level> changes an entry's thinking from boolean to a fixed level and back", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "xai", "--id", "grok", "--model", "grok-4.7", "--auth-env", "NOMARMY_XAI_API_KEY"]);
    const toHigh = runProvidersCLI(root, ["update", "capable", "grok", "--json", "--thinking", "high"]);
    assert.equal(toHigh.exitCode, 0, toHigh.stdout);
    assert.equal(JSON.parse(toHigh.stdout).entry.thinking, "high");

    const toOff = runProvidersCLI(root, ["update", "capable", "grok", "--json", "--no-thinking"]);
    assert.equal(toOff.exitCode, 0, toOff.stdout);
    assert.equal(JSON.parse(toOff.stdout).entry.thinking, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers update --json swaps a native provider's model with no OpenClaw call at all -- registration is per-provider, not per-model", () => {
  const root = scratchNomarmyRoot();
  const fake = withFakeOpenclaw(root);
  try {
    runProvidersCLI(root, [
      "add", "--json", "--pool", "capable", "--provider", "xai", "--id", "grok",
      "--model", "grok-build-0.1", "--auth-env", "NOMARMY_XAI_API_KEY", "--weight", "2",
    ]);
    const { exitCode, stdout } = runProvidersCLI(root, ["update", "capable", "grok", "--json", "--model", "grok-4.7"], fake.env);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.entry.model, "grok-4.7");
    assert.equal(output.entry.auth_env, "NOMARMY_XAI_API_KEY", "unrelated fields must survive an update untouched");
    assert.equal(output.entry.weight, 2, "unrelated fields must survive an update untouched");
    assert.deepEqual(output.changed, ["model"]);
    assert.equal(fake.calls().length, 0, "a model-only swap on a native provider must never shell out to openclaw");
    const after = fs.readFileSync(path.join(root, "config", "providers.yml"), "utf8");
    assert.match(after, /grok-4\.7/);
    assert.doesNotMatch(after, /grok-build-0\.1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers update --json changes weight/max_concurrent independently of model", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "1"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["update", "cheap", "local", "--json", "--weight", "10", "--max-concurrent", "3"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.entry.weight, 10);
    assert.equal(output.entry.max_concurrent, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers update --json with no fields given refuses cleanly instead of writing a no-op", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "1"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["update", "cheap", "local", "--json"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).error, /Nothing to update/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers update --json on an unknown pool/id refuses cleanly, same shape as remove", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "1"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["update", "cheap", "nonexistent", "--json", "--weight", "5"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).error, /No entry with id "nonexistent"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers update --json rejects an invalid resulting entry (e.g. negative weight) without corrupting the file", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "1"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["update", "cheap", "local", "--json", "--weight", "-5"]);
    assert.notEqual(exitCode, 0);
    const after = fs.readFileSync(path.join(root, "config", "providers.yml"), "utf8");
    assert.match(after, /weight: 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// nomarmy subscriptions <list|add|remove>: individually-owned, never-pooled
// workers backed by one person's own already-authenticated subscription.
// Reuses the same scratchNomarmyRoot() isolation providers' own tests use --
// it already copies lib/ wholesale, which includes lib/subscription-*.mjs.
// --------------------------------------------------------------------------
function runSubscriptionsCLI(root, args) {
  try {
    const result = execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "subscriptions", ...args], {
      cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NOMARMY_CONFIG_DIR: path.join(root, "config") },
    });
    return { exitCode: 0, stdout: result, stderr: "" };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("subscriptions list --json with no config/subscriptions.yml reports found:false", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["list", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.found, false);
    assert.deepEqual(output.workers, {});
    // /var is a symlink to /private/var on macOS -- os.tmpdir() and the
    // CLI's own path resolution can spell the same real location two
    // different ways, so compare the meaningful suffix, not the raw string.
    assert.match(output.path, /config[/\\]subscriptions\.yml$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions add --json writes a valid config/subscriptions.yml, defaulting max_concurrent to 1 (not providers' 2)", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["add", "--json", "--name", "jason-claude", "--provider", "claude-cli", "--model", "claude-sonnet-5", "--owner", "jason.pugh@rayson-tech.com"]);
    assert.equal(exitCode, 0, stdout);
    const written = JSON.parse(stdout);
    assert.equal(written.entry.owner, "jason.pugh@rayson-tech.com");
    assert.equal(written.entry.max_concurrent, 1);
    assert.ok(fs.existsSync(path.join(root, "config", "subscriptions.yml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions add --json requires name/provider/model/owner -- refuses cleanly without them", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["add", "--json", "--name", "jason-claude", "--provider", "claude-cli"]);
    assert.notEqual(exitCode, 0);
    assert.match(stdout, /--model.*--owner|--owner.*--model|requires/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions add --json --role writes a role, and two workers claiming the same role are refused without corrupting the file", () => {
  const root = scratchNomarmyRoot();
  try {
    const first = runSubscriptionsCLI(root, ["add", "--json", "--name", "opus", "--provider", "claude-cli", "--model", "claude-opus-5", "--owner", "j@example.com", "--role", "architect"]);
    assert.equal(first.exitCode, 0, first.stdout);
    assert.equal(JSON.parse(first.stdout).entry.role, "architect");

    const dupe = runSubscriptionsCLI(root, ["add", "--json", "--name", "gpt5", "--provider", "codex-cli", "--model", "gpt-5.6", "--owner", "j@example.com", "--role", "architect"]);
    assert.notEqual(dupe.exitCode, 0);
    const after = fs.readFileSync(path.join(root, "config", "subscriptions.yml"), "utf8");
    assert.match(after, /opus:/);
    assert.doesNotMatch(after, /gpt5:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions add --json twice accumulates workers, then list --json shows both", () => {
  const root = scratchNomarmyRoot();
  try {
    runSubscriptionsCLI(root, ["add", "--json", "--name", "jason-claude", "--provider", "claude-cli", "--model", "claude-sonnet-5", "--owner", "jason.pugh@rayson-tech.com"]);
    runSubscriptionsCLI(root, ["add", "--json", "--name", "jason-muse", "--provider", "muse-code", "--model", "muse-spark-1.3", "--owner", "jason.pugh@rayson-tech.com"]);
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["list", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(Object.keys(output.workers).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions add --json refuses \"__proto__\" as a worker name with a clear error, not a silently empty workers file", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["add", "--json", "--name", "__proto__", "--provider", "claude-cli", "--model", "x", "--owner", "y@example.com"]);
    assert.notEqual(exitCode, 0);
    assert.match(stdout, /reserved/);
    assert.equal(fs.existsSync(path.join(root, "config", "subscriptions.yml")), false, "a refused write must not create a partial file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions remove --json removes one worker without disturbing the other", () => {
  const root = scratchNomarmyRoot();
  try {
    runSubscriptionsCLI(root, ["add", "--json", "--name", "jason-claude", "--provider", "claude-cli", "--model", "claude-sonnet-5", "--owner", "jason.pugh@rayson-tech.com"]);
    runSubscriptionsCLI(root, ["add", "--json", "--name", "jason-muse", "--provider", "muse-code", "--model", "muse-spark-1.3", "--owner", "jason.pugh@rayson-tech.com"]);
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["remove", "jason-muse", "--json"]);
    assert.equal(exitCode, 0, stdout);
    assert.deepEqual(JSON.parse(stdout), { removed: true, name: "jason-muse" });
    const after = fs.readFileSync(path.join(root, "config", "subscriptions.yml"), "utf8");
    assert.match(after, /jason-claude:/);
    assert.doesNotMatch(after, /jason-muse:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions remove --json on an unknown name refuses cleanly, naming what DOES exist", () => {
  const root = scratchNomarmyRoot();
  try {
    runSubscriptionsCLI(root, ["add", "--json", "--name", "jason-claude", "--provider", "claude-cli", "--model", "claude-sonnet-5", "--owner", "jason.pugh@rayson-tech.com"]);
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["remove", "typo-name", "--json"]);
    assert.notEqual(exitCode, 0);
    const error = JSON.parse(stdout).error;
    assert.match(error, /Unknown worker "typo-name"/);
    assert.match(error, /jason-claude/);
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

test("subscriptions update --json changes model/role/thinking but never owner or provider", () => {
  const root = scratchNomarmyRoot();
  try {
    runSubscriptionsCLI(root, ["add", "--json", "--name", "you-codex", "--provider", "openai", "--model", "gpt-6-astra", "--owner", "you@example.com", "--role", "ui-ux"]);
    const { exitCode, stdout } = runSubscriptionsCLI(root, ["update", "you-codex", "--json", "--model", "gpt-6-sol", "--no-role", "--thinking", "high", "--owner", "someone-else@example.com"]);
    assert.equal(exitCode, 0, stdout);
    const { entry, changed } = JSON.parse(stdout);
    assert.equal(entry.model, "gpt-6-sol");
    assert.equal(entry.role, undefined);
    assert.equal(entry.thinking, "high");
    assert.equal(entry.owner, "you@example.com", "--owner is not an update flag -- a different owner is a new setup");
    assert.equal(entry.provider, "openai");
    assert.deepEqual(changed.sort(), ["model", "role", "thinking"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscriptions update --json refuses an unknown worker, an empty update, and a role another worker holds", () => {
  const root = scratchNomarmyRoot();
  try {
    runSubscriptionsCLI(root, ["add", "--json", "--name", "a", "--provider", "claude-cli", "--model", "claude-opus-5", "--owner", "o", "--role", "architect"]);
    runSubscriptionsCLI(root, ["add", "--json", "--name", "b", "--provider", "openai", "--model", "gpt-6-astra", "--owner", "o"]);
    const unknown = runSubscriptionsCLI(root, ["update", "nope", "--json", "--model", "x"]);
    assert.notEqual(unknown.exitCode, 0);
    assert.match(JSON.parse(unknown.stdout).error, /Unknown worker "nope"/);
    assert.notEqual(runSubscriptionsCLI(root, ["update", "b", "--json"]).exitCode, 0);
    const clash = runSubscriptionsCLI(root, ["update", "b", "--json", "--role", "architect"]);
    assert.notEqual(clash.exitCode, 0);
    const after = JSON.parse(runSubscriptionsCLI(root, ["list", "--json"]).stdout);
    assert.equal(after.workers.b.role, undefined, "a refused update leaves the file untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test("army init/assign/show --json: global default roster, a project override, and a gitignored local override", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    assert.equal(runArmyCLI(root, repo, ["init", "--json"]).exitCode, 0);
    assert.notEqual(runArmyCLI(root, repo, ["init", "--json"]).exitCode, 0, "never replaces an existing army without --force");
    assert.equal(runArmyCLI(root, repo, ["assign", "ui-ux", "pool:cheap", "--project", "--json"]).exitCode, 0);
    assert.equal(runArmyCLI(root, repo, ["assign", "ui-ux", "local:gpt", "--local", "--json"]).exitCode, 0);
    const summary = JSON.parse(runArmyCLI(root, repo, ["show", "--json"]).stdout);
    assert.deepEqual(summary.roles["ui-ux"].agent, { kind: "local", name: "gpt" });
    assert.equal(summary.roles["ui-ux"].setBy.local, "local");
    assert.equal(summary.roles["ui-ux"].setBy.description, "global");
    assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /^\.nomarmy\.local\.yml$/m);
    assert.match(fs.readFileSync(path.join(repo, ".nomarmy.yml"), "utf8"), /ui-ux:\n\s+pool: cheap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("army assign refuses a malformed target and a role name with spaces", () => {
  const root = scratchNomarmyRoot();
  const repo = mkdtempSync(path.join(tmpdir(), "nomarmy-army-repo-"));
  try {
    assert.notEqual(runArmyCLI(root, repo, ["assign", "pm", "jason-codex", "--json"]).exitCode, 0);
    assert.notEqual(runArmyCLI(root, repo, ["assign", "Project Manager", "local", "--json"]).exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
